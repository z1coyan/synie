defmodule SynieWeb.AuthzMatrixReadTest do
  @moduledoc """
  权限矩阵读侧扫描(authz-e2e 三层防线之一,主体):对夹具世界内每个已覆盖资源,
  以权限目录反射生成的六种极值主体 + 匿名者,经真实 HTTP 管线打 GraphQL 的
  list 与按 id 查询,双向断言「可见集恰好等于应得集」。

  ## 断言语义

  - **正向**:应得记录必须可见(权限系统没把人锁死;只测负向会让"全拒"的坏系统假绿);
  - **负向**:应得集之外的记录一条不可见——含拿到乙司 id 也按 id 查不到;
  - **聚合**:list 的 `count`(唯一被反射枚举的聚合列)必须恰好等于应得数
    (汇总数字不间接泄露他司数据,也顺带证明世界之外没有多余可见行)。
    业务聚合/计算列(如金额合计、持久派生列)不逐资源单独选取断言——它们经
    Ash 读策略与行过滤同一管线求值,值恒等于「可见行之上的聚合」,已由行级
    「恰好等于」传递性保证(spec US #3);唯一残余风险=绕过策略的裸 SQL 聚合,
    不在本反射矩阵射程(与 R2 定点、领域动作出射程同源取舍);
  - **匿名**:一切查询被拒。

  oracle 来自 `World.expected_ids/3` 的应得集声明,断言循环不重新实现过滤逻辑。

  ## Sandbox × setup_all 皱褶(实现决策,工单02)

  世界每模块建一次:`setup_all` 里 `Ecto.Adapters.SQL.Sandbox.start_owner!(shared: true)`
  起一个专职 owner 进程持有沙箱连接,整个模块的建数与 HTTP 请求共用该连接、
  测完随事务回滚。shared 模式是全局的,故本模块必须 `async: false`
  (ExUnit 对 sync 模块串行执行,不会与 async 模块的 :manual 检出打架);
  退出时显式恢复 `:manual`,不污染后续模块。
  """

  use ExUnit.Case, async: false

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
    test "读矩阵:#{module.permission_prefix()}", %{world: world} do
      run_read_matrix(@matrix_module, world)
    end
  end

  # ── 矩阵 runner ──────────────────────────────────────────────────────────

  defp run_read_matrix(module, world) do
    prefix = module.permission_prefix()
    records = Map.fetch!(world.records, module)

    case Gql.read_endpoint!(module) do
      {:list, field} -> run_list_matrix(module, world, prefix, field, records)
      {:read_one, field} -> run_read_one_matrix(module, world, prefix, field, records)
    end
  end

  defp run_list_matrix(module, world, prefix, field, records) do
    # 共享资源(种子/主体夹具/审计副产物产生世界外行)的 list 扫描 id 定界;
    # 独占资源不定界——「恰好等于+count」顺带证明世界之外无多余可见行
    list_query =
      if World.shared?(module),
        do: Gql.bounded_list_query(field, Enum.map(records, & &1.id)),
        else: Gql.list_query(field)

    scan_anonymous(prefix, field, records)

    for subject <- Subjects.extreme_read_subjects(prefix, world) do
      case subject.access do
        :denied ->
          scan_denied(prefix, field, records, subject)

        access ->
          expected = World.expected_ids(world, module, effective_companies(access))
          scan_list(prefix, field, list_query, subject, expected)
          scan_by_id(prefix, field, records, subject, expected)
      end
    end
  end

  # 单行表(read_one 读出口):有码即见该单行,无码/匿名被拒
  defp run_read_one_matrix(module, world, prefix, field, _records) do
    resp = Gql.run(Gql.read_one_query(field))
    assert Gql.denied?(resp, field), deny_msg(prefix, :anonymous, "read_one", resp)

    for subject <- Subjects.extreme_read_subjects(prefix, world) do
      resp = Gql.run(Gql.read_one_query(field), subject.token)

      case subject.access do
        :denied ->
          assert Gql.denied?(resp, field), deny_msg(prefix, subject.shape, "read_one", resp)

        access ->
          expected = World.expected_ids(world, module, effective_companies(access))
          visible = resp |> Gql.read_one_id(field) |> List.wrap() |> MapSet.new()

          assert visible == expected,
                 matrix_msg(
                   prefix,
                   subject.shape,
                   :positive,
                   "read_one 可见集应恰好等于应得集 #{inspect(MapSet.to_list(expected))}," <>
                     "实见 #{inspect(MapSet.to_list(visible))}",
                   resp
                 )
      end
    end
  end

  defp effective_companies(:all), do: :all
  defp effective_companies({:companies, ids}), do: ids

  # 匿名:list 与按 id 全拒(未认证不可达任何数据)
  defp scan_anonymous(prefix, field, records) do
    resp = Gql.run(Gql.list_query(field))
    assert Gql.denied?(resp, field), deny_msg(prefix, :anonymous, "list", resp)

    for record <- records do
      resp = Gql.run(Gql.by_id_query(field, record.id))
      assert Gql.denied?(resp, field), deny_msg(prefix, :anonymous, "按 id", resp)
    end
  end

  # 无码主体:list 与按 id 全拒(无功能授权即无数据)
  defp scan_denied(prefix, field, records, subject) do
    resp = Gql.run(Gql.list_query(field), subject.token)
    assert Gql.denied?(resp, field), deny_msg(prefix, subject.shape, "list", resp)

    for record <- records do
      resp = Gql.run(Gql.by_id_query(field, record.id), subject.token)
      assert Gql.denied?(resp, field), deny_msg(prefix, subject.shape, "按 id", resp)
    end
  end

  # list:双向恰好等于 + count 聚合
  defp scan_list(prefix, field, list_query, subject, expected) do
    resp = Gql.run(list_query, subject.token)
    visible = Gql.visible_ids(resp, field)

    assert visible != nil,
           matrix_msg(prefix, subject.shape, :positive, "持 read 码的 list 查询不应整体被拒", resp)

    missing = MapSet.difference(expected, visible)

    assert MapSet.size(missing) == 0,
           matrix_msg(
             prefix,
             subject.shape,
             :positive,
             "应得记录在 list 中不可见(权限把人锁死):#{inspect(MapSet.to_list(missing))}",
             resp
           )

    extra = MapSet.difference(visible, expected)

    assert MapSet.size(extra) == 0,
           matrix_msg(
             prefix,
             subject.shape,
             :negative,
             "list 泄露应得集之外的记录:#{inspect(MapSet.to_list(extra))}",
             resp
           )

    assert Gql.count(resp, field) == MapSet.size(expected),
           matrix_msg(
             prefix,
             subject.shape,
             :negative,
             "count 聚合应恰好等于应得数 #{MapSet.size(expected)},实为 #{inspect(Gql.count(resp, field))}",
             resp
           )
  end

  # 按 id:应得记录逐条可查(正向),其余记录拿到 id 也查不到(负向)
  defp scan_by_id(prefix, field, records, subject, expected) do
    for record <- records do
      resp = Gql.run(Gql.by_id_query(field, record.id), subject.token)
      visible = Gql.visible_ids(resp, field)

      if MapSet.member?(expected, record.id) do
        assert visible == MapSet.new([record.id]),
               matrix_msg(
                 prefix,
                 subject.shape,
                 :positive,
                 "应得记录 #{record.id} 按 id 查询不可见",
                 resp
               )
      else
        assert visible == MapSet.new(),
               matrix_msg(
                 prefix,
                 subject.shape,
                 :negative,
                 "非应得记录 #{record.id} 拿到 id 仍可按 id 查到",
                 resp
               )
      end
    end
  end

  # ── 失败信息:点名 资源 × 主体形态 × 方向 ────────────────────────────────

  defp matrix_msg(prefix, shape, direction, detail, resp) do
    dir = if direction == :positive, do: "正向", else: "负向"

    "[矩阵] 资源 #{prefix} × 主体 #{shape} × #{dir}:#{detail}\n响应:#{inspect(resp, limit: 20)}"
  end

  defp deny_msg(prefix, shape, op, resp) do
    "[矩阵] 资源 #{prefix} × 主体 #{shape} × 负向:#{op} 查询应被拒(errors 且无数据)\n响应:#{inspect(resp, limit: 20)}"
  end
end
