defmodule SynieCore.AuthzFixtures do
  @moduledoc "权限相关测试夹具。内部路径统一 `authorize?: false`。"

  alias SynieCore.Accounts.User
  alias SynieCore.Authz.{Role, RolePermission, UserRole}

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
end
