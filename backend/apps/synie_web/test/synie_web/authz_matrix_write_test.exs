defmodule SynieWeb.AuthzMatrixWriteTest do
  @moduledoc """
  权限矩阵写侧扫描(W1,authz-e2e 工单03):对夹具世界内每个已覆盖资源,
  经真实 HTTP 管线打 GraphQL 三件套 mutation,断言——

  - **无码全拒**:匿名与无码主体的 create/update/destroy 一律被拒(含本司);
  - **跨公司三件套**(公司隔离资源):只授公司甲的最小写主体,在乙司 create
    被拒、update 乙司记录被拒、destroy 乙司记录被拒;全局资源无公司轴,跳过;
  - **世界不变式**:负向扫完后 super_admin 的可见集仍恰好等于世界记录
    ——「被拒」不是靠错误形态自证,而是靠数据没动过实证;
  - **正向对照**:最小写主体在甲司 create→update→destroy 全程成功(净零,
    不扰动世界),防"全部拒绝"的坏系统假绿。仅注册 update 的资源
    (sys.user/设置类)对世界记录做一次良性 update 作为正向;仅注册 create
    的资源正向后经受信路径清场(测试管道,不属断言面)。

  mutation 字段名经域 mutations 反射(通用三件套=动作名与类型同名,见
  `Gql.primary_mutation_fields/1`),资源没注册某件 mutation 就自动跳过该件
  ——写出口不存在即无从越权。oracle 输入来自 `World.write_inputs/1`
  的写输入契约,覆盖守卫强制其与 mutation 注册保持同步。

  Sandbox 皱褶同读矩阵(见 `SynieWeb.AuthzMatrixReadTest` moduledoc):
  世界每模块一建,专职 owner 进程 + shared 模式,async: false,退出恢复 :manual。
  """

  use ExUnit.Case, async: false

  import Ecto.Query, only: [from: 2]

  alias SynieWeb.AuthzMatrix.{Gql, Subjects, World}

  setup_all do
    owner = Ecto.Adapters.SQL.Sandbox.start_owner!(SynieCore.Repo, shared: true)
    world = World.build!()

    on_exit(fn ->
      File.rm_rf!(world.storage_root)
      Ecto.Adapters.SQL.Sandbox.stop_owner(owner)
      Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
    end)

    %{world: world}
  end

  for {module, _builder} <- World.builders() do
    @matrix_module module
    test "写矩阵:#{module.permission_prefix()}", %{world: world} do
      run_write_matrix(@matrix_module, world)
    end
  end

  # ── 矩阵 runner ──────────────────────────────────────────────────────────

  defp run_write_matrix(module, world) do
    prefix = module.permission_prefix()
    fields = Gql.primary_mutation_fields(module)
    inputs = Map.get(World.write_inputs(world.ctx), module)
    records = Map.fetch!(world.records, module)
    subjects = Subjects.extreme_write_subjects(prefix, world)
    company_scoped? = World.visibility(module) == :company

    # 拒绝/正向的靶记录:公司隔离资源分甲乙,全局资源取世界首条(无公司轴)
    {record_a, record_b} =
      if company_scoped? do
        {Enum.find(records, &(&1.company_id == world.company_a.id)),
         Enum.find(records, &(&1.company_id == world.company_b.id))}
      else
        {List.first(records), nil}
      end

    # 匿名与无码:一切写 mutation 被拒(以本司甲为靶,证明拒因是"无码"而非公司轴)
    scan_no_code(prefix, :anonymous, nil, fields, inputs, world.company_a, record_a)
    scan_no_code(prefix, :no_code, subjects.no_code, fields, inputs, world.company_a, record_a)

    # 跨公司三件套:只授甲的最小写主体,对乙司全拒(全局资源无公司轴,跳过)
    if company_scoped? do
      scan_cross_company(prefix, subjects.min_write_a, fields, inputs, world.company_b, record_b)
    end

    # 世界不变式:负向扫完,super_admin 可见集仍恰好等于世界记录
    assert_world_intact(prefix, module, world, subjects.super_admin, "负向扫描后")

    # 正向对照:甲司 create→update→destroy 全程成功(净零,防全拒假绿);
    # 乙司同套动作由甲乙双授权主体走通——证明上面跨公司负向的拒因是公司轴,不是输入不合法
    if inputs do
      positive_control(
        prefix,
        module,
        :min_write_a,
        subjects.min_write_a,
        fields,
        inputs,
        world.company_a,
        record_a
      )

      positive_control(
        prefix,
        module,
        :min_write_ab,
        subjects.min_write_ab,
        fields,
        inputs,
        world.company_b,
        record_b || record_a
      )
    end

    assert_world_intact(prefix, module, world, subjects.super_admin, "正向对照后")
  end

  defp scan_no_code(prefix, shape, token, fields, inputs, company, record) do
    if fields.create && inputs[:create] do
      resp = Gql.run(Gql.create_mutation(fields.create, inputs.create.(company)), token)

      assert Gql.mutation_denied?(resp, fields.create),
             write_msg(prefix, shape, :negative, "本司 create 应被拒(无码即无写)", resp)
    end

    if fields.update && inputs[:update] && record do
      resp = Gql.run(Gql.update_mutation(fields.update, record.id, inputs.update.()), token)

      assert Gql.mutation_denied?(resp, fields.update),
             write_msg(prefix, shape, :negative, "本司 update 应被拒(无码即无写)", resp)
    end

    if fields.destroy && record do
      resp = Gql.run(Gql.destroy_mutation(fields.destroy, record.id), token)

      assert Gql.mutation_denied?(resp, fields.destroy),
             write_msg(prefix, shape, :negative, "本司 destroy 应被拒(无码即无写)", resp)
    end
  end

  defp scan_cross_company(prefix, token, fields, inputs, company_b, record_b) do
    if fields.create && inputs[:create] do
      resp = Gql.run(Gql.create_mutation(fields.create, inputs.create.(company_b)), token)

      assert Gql.mutation_denied?(resp, fields.create),
             write_msg(prefix, :min_write_a, :negative, "跨公司 create(落乙司)应被拒", resp)
    end

    if fields.update && inputs[:update] && record_b do
      resp = Gql.run(Gql.update_mutation(fields.update, record_b.id, inputs.update.()), token)

      assert Gql.mutation_denied?(resp, fields.update),
             write_msg(prefix, :min_write_a, :negative, "update 乙司记录应被拒", resp)
    end

    if fields.destroy && record_b do
      resp = Gql.run(Gql.destroy_mutation(fields.destroy, record_b.id), token)

      assert Gql.mutation_denied?(resp, fields.destroy),
             write_msg(prefix, :min_write_a, :negative, "destroy 乙司记录应被拒", resp)
    end
  end

  defp positive_control(prefix, module, shape, token, fields, inputs, company, world_record) do
    cond do
      fields.create && inputs[:create] ->
        positive_lifecycle(prefix, module, shape, token, fields, inputs, company)

      fields.update && inputs[:update] && world_record ->
        # 仅注册 update 的资源:对世界记录做良性变更作为正向(id 不变,不扰动世界)
        resp =
          Gql.run(Gql.update_mutation(fields.update, world_record.id, inputs.update.()), token)

        assert Gql.mutation_result_id(resp, fields.update) == world_record.id,
               write_msg(prefix, shape, :positive, "正向对照:授权范围内 update 应成功(防全拒假绿)", resp)

      true ->
        :ok
    end
  end

  defp positive_lifecycle(prefix, module, shape, token, fields, inputs, company) do
    resp = Gql.run(Gql.create_mutation(fields.create, inputs.create.(company)), token)
    created_id = Gql.mutation_result_id(resp, fields.create)

    assert created_id,
           write_msg(prefix, shape, :positive, "正向对照:授权公司内 create 应成功(防全拒假绿)", resp)

    if fields.update && inputs[:update] do
      resp = Gql.run(Gql.update_mutation(fields.update, created_id, inputs.update.()), token)

      assert Gql.mutation_result_id(resp, fields.update) == created_id,
             write_msg(prefix, shape, :positive, "正向对照:授权公司内 update 应成功", resp)
    end

    if fields.destroy do
      resp = Gql.run(Gql.destroy_mutation(fields.destroy, created_id), token)

      assert Gql.mutation_result_id(resp, fields.destroy) == created_id,
             write_msg(prefix, shape, :positive, "正向对照:授权公司内 destroy 应成功(顺带净零收场)", resp)
    else
      # 无 destroy mutation(如 base.market_price):受信路径清场,保住世界不变式。
      # 测试管道,不属断言面。
      trusted_cleanup(module, created_id)
    end
  end

  # 世界不变式:被拒不能只看错误形态,还要看数据确实没动
  defp assert_world_intact(prefix, module, world, super_token, moment) do
    world_ids = MapSet.new(Map.fetch!(world.records, module), & &1.id)

    visible =
      case Gql.read_endpoint!(module) do
        {:list, field} ->
          # 共享资源(存在世界外行)定界到世界记录,独占资源全量扫
          query =
            if World.shared?(module),
              do: Gql.bounded_list_query(field, MapSet.to_list(world_ids)),
              else: Gql.list_query(field)

          resp = Gql.run(query, super_token)
          {Gql.visible_ids(resp, field), resp}

        {:read_one, field} ->
          resp = Gql.run(Gql.read_one_query(field), super_token)
          {resp |> Gql.read_one_id(field) |> List.wrap() |> MapSet.new(), resp}
      end

    {visible_ids, resp} = visible

    assert visible_ids == world_ids,
           write_msg(
             prefix,
             :super_admin,
             :invariant,
             "#{moment}世界应恰好完整:期望 #{inspect(MapSet.to_list(world_ids))}," <>
               "实见 #{inspect(visible_ids && MapSet.to_list(visible_ids))}",
             resp
           )
  end

  # 失败信息规格与读侧一致:资源 × 主体形态 × 方向
  defp write_msg(prefix, shape, direction, detail, resp) do
    dir =
      case direction do
        :negative -> "负向"
        :positive -> "正向"
        :invariant -> "不变式"
      end

    "[矩阵·写] 资源 #{prefix} × 主体 #{shape} × #{dir}:#{detail}\n响应:#{inspect(resp, limit: 20)}"
  end

  # 受信清场:绕过动作层直删(仅测试管道用;见 positive_lifecycle)
  defp trusted_cleanup(module, id) do
    SynieCore.Repo.delete_all(from(r in module, where: r.id == ^id))
  end
end
