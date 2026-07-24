defmodule SynieCore.Authz.MountGuardTest do
  @moduledoc """
  静态挂载守卫:抓「忘了挂」这一最常见的权限事故形态(authz-e2e 三层防线之二)。

  纯内省、不碰数据库:遍历 SynieCore 域内全部资源,断言——

  1. 每个资源都挂 `Ash.Policy.Authorizer`(否则策略层整体缺席);
  2. 每个资源都声明 `permission_prefix/0`(权限目录的枚举源);
  3. 每个动作都被至少一条含 `HasPermission` 的非 bypass 策略覆盖(功能权限);
  4. 带 `company_id` 的资源,每个 read 动作都被 `CompanyScope` 策略覆盖(公司读过滤);
  5. 带 `company_id` 的资源,能写 `company_id` 的动作都挂 `CompanyAccessible`(公司写校验)。

  策略覆盖用静态近似判断:条件仅识别 `always()`/`action_type(...)`/`action(...)`
  三种形状(当前全库仅此三种),未知条件形状一律视为不覆盖——宁可误报逼人补豁免,
  不可漏报放过真漏挂。

  故意偏离标准三段式的挂载进显式豁免清单,必须带书面理由;豁免项失效(资源修复后
  忘删)同样报错,防清单腐烂。动态行为(矩阵扫描)由 synie_web 的权限矩阵套件负责,
  本守卫只管「挂没挂」。
  """

  use ExUnit.Case, async: true

  alias SynieCore.Authz.Checks.{CompanyScope, HasPermission}
  alias SynieCore.Authz.Validations.CompanyAccessible

  # ── 豁免清单(不允许无理由豁免;修复后必须同步删除对应项)─────────────────

  # 动作未被 HasPermission 策略覆盖的豁免:{资源, 动作} => 理由
  @permission_policy_exempt %{
    {SynieCore.Accounts.User, :set_super_admin} =>
      "无任何策略匹配 → Ash 默认拒绝(fail-closed);仅超管 bypass 或 seeds 等受信内部路径可用",
    {SynieCore.Acc.Setting, :ocr_configured} =>
      "配置态布尔仅供前端 OCR 按钮防呆,不含凭证内容,策略为 actor_present()(登录即可读)",
    {SynieCore.Sys.Setting, :record_market_fetch} =>
      "行情拉取运行状态回写,无策略匹配 → Ash 默认拒绝;仅调度器/手动刷新以 authorize?: false 调用"
  }

  # 带 company_id 资源的 read 未被 CompanyScope 覆盖的豁免:资源 => 理由
  @company_read_exempt %{
    SynieCore.Authz.UserCompany => "company_id 是授权载荷(授予哪家公司)而非数据归属维度;读跟随 sys.user:read,不该按公司过滤"
  }

  # 能写 company_id 的动作未挂 CompanyAccessible 的豁免:{资源, 动作} => 理由
  @company_write_exempt %{
    {SynieCore.Inv.StockEntry, :create} =>
      "仅 Inv.Stock.post! 以 authorize?: false 内部调用,不注册 GraphQL mutation;company_id 派生自来源单据",
    {SynieCore.Acc.GlEntry, :create} =>
      "仅 GL.post! 以 authorize?: false 内部调用,不注册 GraphQL mutation;company_id 派生自来源凭证",
    {SynieCore.Acc.BankImportItem, :create} =>
      "仅导入解析(ParseOnCreate bulk_create)内部使用,不注册 GraphQL mutation;company_id 派生自导入批次",
    {SynieCore.Files.Attachment, :create} =>
      "仅 Files.maybe_attach/attach 内部调用,不注册 GraphQL mutation;company_id 从宿主去规范化写入",
    {SynieCore.Acc.BillHolding, :rebuild} =>
      "仅 BillLedger.replay! 以 authorize?: false 整删整建,不注册 GraphQL mutation;company_id 派生自票据",
    {SynieCore.Authz.UserCompany, :create} =>
      "company_id 是授权载荷而非数据归属;持 sys.user:update 者本就在分配公司数据权限,无自限一说"
  }

  defp resources, do: Ash.Domain.Info.resources(SynieCore)

  # policy group 会嵌套,拍平成 %Ash.Policy.Policy{} 列表
  defp flat_policies(resource) do
    resource |> Ash.Policy.Info.policies() |> do_flatten()
  end

  defp do_flatten(items) do
    Enum.flat_map(items, fn
      %Ash.Policy.Policy{} = p -> [p]
      %{policies: nested} -> do_flatten(nested)
      _other -> []
    end)
  end

  defp has_check?(%Ash.Policy.Policy{policies: checks}, check_module) do
    Enum.any?(checks, fn
      %Ash.Policy.Check{check: {^check_module, _opts}} -> true
      _other -> false
    end)
  end

  # 静态条件匹配:只认全库现存的三种条件形状,未知形状按不覆盖处理(宁误报不漏报)
  defp condition_matches?(condition, action) do
    Enum.all?(List.wrap(condition), fn
      {Ash.Policy.Check.Static, opts} -> Keyword.get(opts, :result) == true
      {Ash.Policy.Check.ActionType, opts} -> action.type in List.wrap(opts[:type])
      {Ash.Policy.Check.Action, opts} -> action.name in List.wrap(opts[:action])
      _unknown -> false
    end)
  end

  defp covered_by?(resource, action, check_module) do
    resource
    |> flat_policies()
    |> Enum.any?(fn p ->
      p.bypass? != true and has_check?(p, check_module) and
        condition_matches?(p.condition, action)
    end)
  end

  defp company_scoped?(resource), do: Ash.Resource.Info.attribute(resource, :company_id) != nil

  # 能写 company_id 的动作:accept 含 company_id,或有同名 argument
  defp writes_company_id?(action) do
    action.type in [:create, :update] and
      (:company_id in Map.get(action, :accept, []) or
         Enum.any?(Map.get(action, :arguments, []), &(&1.name == :company_id)))
  end

  defp company_accessible_mounted?(resource, action) do
    action_level =
      action
      |> Map.get(:changes, [])
      |> Enum.any?(fn
        %Ash.Resource.Validation{validation: {CompanyAccessible, _opts}} -> true
        _other -> false
      end)

    resource_level =
      resource
      |> Ash.Resource.Info.validations()
      |> Enum.any?(fn v ->
        match?({CompanyAccessible, _opts}, v.validation) and action.type in v.on
      end)

    action_level or resource_level
  end

  defp assert_no_offenders(offenders, header) do
    assert offenders == [],
           "#{header}\n" <> Enum.map_join(offenders, "\n", &("  - " <> &1))
  end

  # 豁免清单卫生:清单里的键必须仍然「需要豁免」,修好了就得删,防清单腐烂
  defp assert_no_stale(stale, list_name) do
    assert stale == [],
           "#{list_name} 中以下豁免项已失效(问题已修复),请从清单删除:\n" <>
             Enum.map_join(stale, "\n", &("  - " <> inspect(&1)))
  end

  test "每个域资源都挂 Ash.Policy.Authorizer" do
    offenders =
      for r <- resources(), Ash.Policy.Authorizer not in Ash.Resource.Info.authorizers(r) do
        "#{inspect(r)}: authorizers 缺 Ash.Policy.Authorizer(策略层整体缺席)"
      end

    assert_no_offenders(offenders, "以下资源没有挂策略授权器:")
  end

  test "每个域资源都声明 permission_prefix/0" do
    offenders =
      for r <- resources(),
          not (Code.ensure_loaded?(r) and function_exported?(r, :permission_prefix, 0)) do
        "#{inspect(r)}: 未声明 permission_prefix/0(不进权限目录,HasPermission 恒拒绝也无法授权)"
      end

    assert_no_offenders(offenders, "以下资源未声明权限前缀:")
  end

  test "每个动作都被含 HasPermission 的策略覆盖(功能权限)" do
    found =
      for r <- resources(),
          action <- Ash.Resource.Info.actions(r),
          not covered_by?(r, action, HasPermission),
          do: {r, action.name}

    offenders =
      for {r, name} <- found, not Map.has_key?(@permission_policy_exempt, {r, name}) do
        "#{inspect(r)} 动作 #{inspect(name)}: 无含 HasPermission 的策略覆盖(如属故意,进豁免清单并写明理由)"
      end

    stale = Map.keys(@permission_policy_exempt) -- found

    assert_no_offenders(offenders, "以下动作缺功能权限策略:")
    assert_no_stale(stale, "@permission_policy_exempt")
  end

  test "带 company_id 的资源:read 动作都被 CompanyScope 覆盖(公司读过滤)" do
    found =
      for r <- resources(),
          company_scoped?(r),
          action <- Ash.Resource.Info.actions(r),
          action.type == :read,
          not covered_by?(r, action, CompanyScope),
          do: {r, action.name}

    offenders =
      for {r, name} <- found, not Map.has_key?(@company_read_exempt, r) do
        "#{inspect(r)} read 动作 #{inspect(name)}: 未被 CompanyScope 覆盖(跨公司读泄露风险)"
      end

    stale =
      for r <- Map.keys(@company_read_exempt),
          not Enum.any?(found, fn {fr, _} -> fr == r end),
          do: r

    assert_no_offenders(offenders, "以下资源的 read 缺公司读过滤:")
    assert_no_stale(stale, "@company_read_exempt")
  end

  test "带 company_id 的资源:能写 company_id 的动作都挂 CompanyAccessible(公司写校验)" do
    found =
      for r <- resources(),
          company_scoped?(r),
          action <- Ash.Resource.Info.actions(r),
          writes_company_id?(action),
          not company_accessible_mounted?(r, action),
          do: {r, action.name}

    offenders =
      for {r, name} <- found, not Map.has_key?(@company_write_exempt, {r, name}) do
        "#{inspect(r)} 动作 #{inspect(name)}: accept/argument 含 company_id 却未挂 CompanyAccessible(跨公司写风险)"
      end

    stale = Map.keys(@company_write_exempt) -- found

    assert_no_offenders(offenders, "以下动作缺公司写校验:")
    assert_no_stale(stale, "@company_write_exempt")
  end
end
