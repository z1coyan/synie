defmodule SynieCore.AuthzFixtures do
  @moduledoc "权限相关测试夹具。内部路径统一 `authorize?: false`。"

  require Ash.Query

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}
  alias SynieCore.Base.Company
  alias SynieCore.Base.Currency

  def user!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{username: "user_#{System.unique_integer([:positive])}", password: "secret123"},
        attrs
      )

    User
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  def role!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{code: "role_#{System.unique_integer([:positive])}", name: "测试角色"},
        attrs
      )

    Role
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  def grant!(role, permission) do
    RolePermission
    |> Ash.Changeset.for_create(:create, %{role_id: role.id, permission: permission})
    |> Ash.create!(authorize?: false)
  end

  def assign!(user, role) do
    UserRole
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, role_id: role.id})
    |> Ash.create!(authorize?: false)
  end

  def company!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{
          code: unique_company_code(),
          name: "测试公司",
          short_name: "测司",
          base_currency_id: cny!().id
        },
        attrs
      )

    Company
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # 本币夹具:CNY 取或建(iso_code 全局唯一,同一测试沙箱内多次建公司复用同一条)
  def cny! do
    Currency
    |> Ash.Query.filter(iso_code == "CNY")
    |> Ash.read_one!(authorize?: false)
    |> case do
      nil ->
        Currency
        |> Ash.Changeset.for_create(:create, %{name: "人民币", iso_code: "CNY", symbol: "￥"})
        |> Ash.create!(authorize?: false)

      currency ->
        currency
    end
  end

  # 外币夹具(改名避开各 acc 测试模块的本地 currency! 助手)
  def foreign_currency!(attrs) do
    attrs =
      Map.merge(
        %{name: "测试货币", iso_code: unique_iso_code(), symbol: "¤"},
        attrs
      )

    Currency
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  # ISO 码固定三位大写字母,同 code 映射法(17576 个,同一测试事务内足够)
  defp unique_iso_code do
    i = System.unique_integer([:positive])
    <<?A + rem(div(i, 676), 26), ?A + rem(div(i, 26), 26), ?A + rem(i, 26)>>
  end

  # 公司 code 固定两位英文字母,把递增整数映射到 aa..zz(676 个,同一测试事务内足够)
  defp unique_company_code do
    i = System.unique_integer([:positive])
    <<?a + rem(div(i, 26), 26), ?a + rem(i, 26)>>
  end

  def grant_company!(user, company) do
    UserCompany
    |> Ash.Changeset.for_create(:create, %{user_id: user.id, company_id: company.id})
    |> Ash.create!(authorize?: false)
  end
end
