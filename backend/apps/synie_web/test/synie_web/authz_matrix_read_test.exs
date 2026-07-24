defmodule SynieWeb.AuthzMatrixReadTest do
  @moduledoc """
  权限矩阵读侧扫描(authz-e2e 三层防线之一,主体):对夹具世界内每个已覆盖资源,
  以权限目录反射生成的六种极值主体 + 匿名者,经真实 HTTP 管线打 GraphQL 的
  list 与按 id 查询,双向断言「可见集恰好等于应得集」。

  ## 断言语义

  - **正向**:应得记录必须可见(权限系统没把人锁死;只测负向会让"全拒"的坏系统假绿);
  - **负向**:应得集之外的记录一条不可见——含拿到乙司 id 也按 id 查不到;
  - **聚合**:list 的 count 必须恰好等于应得数(汇总数字不间接泄露他司数据,
    也顺带证明世界之外没有多余可见行);
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

    on_exit(fn ->
      Ecto.Adapters.SQL.Sandbox.stop_owner(owner)
      Ecto.Adapters.SQL.Sandbox.mode(SynieCore.Repo, :manual)
    end)

    %{world: World.build!()}
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
    field = grid_field!(module)
    records = Map.fetch!(world.records, module)

    scan_anonymous(prefix, field, records)

    for subject <- Subjects.extreme_read_subjects(prefix, world) do
      case subject.access do
        :denied ->
          scan_denied(prefix, field, records, subject)

        access ->
          expected = World.expected_ids(world, module, effective_companies(access))
          scan_list(prefix, field, subject, expected)
          scan_by_id(prefix, field, records, subject, expected)
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
  defp scan_list(prefix, field, subject, expected) do
    resp = Gql.run(Gql.list_query(field), subject.token)
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

  # 读侧枚举源 = 表格元数据白名单:资源模块 → GraphQL list 字段名
  defp grid_field!(module) do
    SynieWeb.GridMeta.resources()
    |> Enum.find(fn {_name, m} -> m == module end)
    |> case do
      {name, _} -> name
      nil -> flunk("资源 #{inspect(module)} 不在 GridMeta 白名单,读矩阵无法枚举其查询名")
    end
  end
end
