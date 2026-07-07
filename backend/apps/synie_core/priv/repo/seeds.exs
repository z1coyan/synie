# 初始化系统用户。
# 运行:cd backend/apps/synie_core && mix run priv/repo/seeds.exs

require Ash.Query

alias SynieCore.Accounts.User

username = "admin"

user =
  User
  |> Ash.Query.filter(username == ^username)
  |> Ash.read_one!(authorize?: false)

user =
  if user do
    IO.puts("用户 #{username} 已存在,跳过创建")
    user
  else
    created =
      User
      |> Ash.Changeset.for_create(:register, %{
        username: username,
        name: "系统管理员",
        password: "admin123"
      })
      |> Ash.create!(authorize?: false)

    IO.puts("已创建用户 #{username}(初始密码 admin123)")
    created
  end

unless user.super_admin do
  user
  |> Ash.Changeset.for_update(:set_super_admin, %{})
  |> Ash.update!(authorize?: false)

  IO.puts("已将 #{username} 标记为超级管理员")
end
