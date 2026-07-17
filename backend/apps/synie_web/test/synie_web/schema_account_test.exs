defmodule SynieWeb.SchemaAccountTest do
  @moduledoc "科目表 GraphQL 端到端:模板初始化 + 树形父子懒加载查询,对齐前端契约。"

  use ExUnit.Case, async: true

  alias SynieCore.Accounts.User
  alias SynieCore.Authz
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}
  alias SynieCore.Base.Company

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp uniq, do: System.unique_integer([:positive])

  # 公司 code 固定两位字母
  defp co_code do
    i = uniq()
    <<?a + rem(div(i, 26), 26), ?a + rem(i, 26)>>
  end

  defp company! do
    Company
    |> Ash.Changeset.for_create(:create, %{
      code: co_code(),
      name: "测试公司",
      short_name: "测司",
      base_currency_id: base_currency_id!()
    })
    |> Ash.create!(authorize?: false)
  end

  # 公司本币必填;CNY 已由迁移种入,取或建(synie_web 用不到 synie_core 的测试夹具)
  defp base_currency_id! do
    case Ash.get(SynieCore.Base.Currency, %{iso_code: "CNY"}, authorize?: false, error?: false) do
      {:ok, %{id: id}} when is_binary(id) ->
        id

      _ ->
        SynieCore.Base.Currency
        |> Ash.Changeset.for_create(:create, %{name: "人民币", iso_code: "CNY", symbol: "￥"})
        |> Ash.create!(authorize?: false)
        |> Map.fetch!(:id)
    end
  end

  defp user_with!(permissions, companies) do
    user =
      User
      |> Ash.Changeset.for_create(:create, %{username: "u_#{uniq()}", password: "secret123"})
      |> Ash.create!(authorize?: false)

    role =
      Role
      |> Ash.Changeset.for_create(:create, %{code: "r_#{uniq()}", name: "角色"})
      |> Ash.create!(authorize?: false)

    Enum.each(permissions, fn code ->
      RolePermission
      |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: code})
      |> Ash.create!(authorize?: false)
    end)

    UserRole
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, role_id: role.id})
    |> Ash.create!(authorize?: false)

    Enum.each(companies, fn co ->
      UserCompany
      |> Ash.Changeset.for_create(:create, %{user_id: user.id, company_id: co.id})
      |> Ash.create!(authorize?: false)
    end)

    user
  end

  defp run!(doc, actor) do
    {:ok, result} = Absinthe.run(doc, SynieWeb.Schema, context: %{actor: actor})
    result
  end

  test "从模板初始化后按父子两级懒加载查询" do
    co = company!()

    # 只授 create/read:初始化复用 create 权限码({HasPermission, as: "create"}),无独立权限点
    actor = Authz.build_actor(user_with!(["base.account:create", "base.account:read"], [co]))

    # 初始化(小企业准则 70 条),泛型 action 直接返回 Int
    init =
      run!(
        ~s|mutation { initBasAccountFromTemplate(input: {companyId: "#{co.id}", template: SMALL}) }|,
        actor
      )

    assert %{data: %{"initBasAccountFromTemplate" => 70}} = init

    # 根层:parentId 为空 + 公司过滤,带 hasChildren(前端据此显示展开箭头)
    roots =
      run!(
        ~s|query { basAccounts(filter: {parentId: {isNil: true}, companyId: {eq: "#{co.id}"}}, sort: [{field: CODE, order: ASC}]) { count results { id code name hasChildren } } }|,
        actor
      )

    assert %{data: %{"basAccounts" => %{"results" => root_rows}}} = roots
    assert length(root_rows) == 5
    asset = Enum.find(root_rows, &(&1["code"] == "1"))
    assert asset["name"] == "资产"
    assert asset["hasChildren"] == true

    # 子层:按 parentId eq 拉直接子科目(前端展开时的懒加载请求)
    children =
      run!(
        ~s|query { basAccounts(filter: {parentId: {eq: "#{asset["id"]}"}}) { results { code name } } }|,
        actor
      )

    assert %{data: %{"basAccounts" => %{"results" => child_rows}}} = children
    assert Enum.any?(child_rows, &(&1["code"] == "1001" and &1["name"] == "库存现金"))
  end

  test "有功能权限但无公司授权,初始化被拒(fail-closed)" do
    co = company!()
    actor = Authz.build_actor(user_with!(["base.account:*"], []))

    result =
      run!(
        ~s|mutation { initBasAccountFromTemplate(input: {companyId: "#{co.id}", template: SMALL}) }|,
        actor
      )

    assert %{errors: [%{message: msg} | _]} = result
    assert msg =~ "无权"
  end

  test "只有 read 权限不能初始化(需 create)" do
    co = company!()
    actor = Authz.build_actor(user_with!(["base.account:read"], [co]))

    result =
      run!(
        ~s|mutation { initBasAccountFromTemplate(input: {companyId: "#{co.id}", template: SMALL}) }|,
        actor
      )

    assert result[:errors] != nil and result[:errors] != []
  end
end
