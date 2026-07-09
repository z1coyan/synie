defmodule SynieCore.AuthzFixtures do
  @moduledoc "权限相关测试夹具。内部路径统一 `authorize?: false`。"

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserCompany, UserRole}
  alias SynieCore.Base.Company

  def user!(attrs \\ %{}) do
    attrs =
      Map.merge(
        %{username: "user_#{System.unique_integer([:positive])}", password: "secret123"},
        attrs
      )

    User
    |> Ash.Changeset.for_create(:register, attrs)
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
        %{code: unique_company_code(), name: "测试公司", short_name: "测司"},
        attrs
      )

    Company
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
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
