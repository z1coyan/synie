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
      |> Ash.Changeset.for_create(:create, %{
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

# 内置存储接入:local(全局默认,不可删除)。已存在则跳过,不覆盖用户改过的 root。
alias SynieCore.Files.StorageEndpoint

local =
  StorageEndpoint
  |> Ash.Query.filter(name == "local")
  |> Ash.read_one!(authorize?: false)

if local do
  IO.puts("存储接入 local 已存在,跳过创建")
else
  root = System.get_env("UPLOADS_ROOT") || "uploads"

  StorageEndpoint
  |> Ash.Changeset.for_create(:create, %{name: "local", label: "本地存储", kind: :local, root: root})
  |> Ash.Changeset.force_change_attribute(:builtin, true)
  |> Ash.Changeset.force_change_attribute(:is_default, true)
  |> Ash.create!(authorize?: false)

  IO.puts("已创建内置存储接入 local(根目录 #{root})")
end
