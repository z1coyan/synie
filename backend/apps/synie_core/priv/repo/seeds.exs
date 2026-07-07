# 初始化系统用户。
# 运行:cd backend/apps/synie_core && mix run priv/repo/seeds.exs

require Ash.Query

alias SynieCore.Accounts.User

username = "admin"

exists? =
  User
  |> Ash.Query.filter(username == ^username)
  |> Ash.exists?()

if exists? do
  IO.puts("用户 #{username} 已存在,跳过")
else
  User
  |> Ash.Changeset.for_create(:register, %{
    username: username,
    name: "系统管理员",
    password: "admin123"
  })
  |> Ash.create!()

  IO.puts("已创建用户 #{username}(初始密码 admin123)")
end
