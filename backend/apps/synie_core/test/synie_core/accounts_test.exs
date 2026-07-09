defmodule SynieCore.AccountsTest do
  use ExUnit.Case, async: true

  alias SynieCore.Accounts
  alias SynieCore.Accounts.User

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)
  end

  defp register!(attrs) do
    User
    |> Ash.Changeset.for_create(:create, attrs)
    |> Ash.create!(authorize?: false)
  end

  test "create 会把密码哈希后存入 hashed_password" do
    user = register!(%{username: "alice", name: "Alice", password: "secret123"})

    assert String.starts_with?(user.hashed_password, "$pbkdf2-")
    refute user.hashed_password == "secret123"
  end

  test "authenticate 使用正确凭证返回用户" do
    register!(%{username: "bob", password: "secret123"})

    assert {:ok, user} = Accounts.authenticate("bob", "secret123")
    assert to_string(user.username) == "bob"
  end

  test "authenticate 用户名不区分大小写" do
    register!(%{username: "Carol", password: "secret123"})

    assert {:ok, _user} = Accounts.authenticate("carol", "secret123")
  end

  test "authenticate 对错误密码与不存在的用户统一报错" do
    register!(%{username: "dave", password: "secret123"})

    assert {:error, :invalid_credentials} = Accounts.authenticate("dave", "wrong")
    assert {:error, :invalid_credentials} = Accounts.authenticate("nobody", "wrong")
  end

  test "用户名唯一" do
    register!(%{username: "erin", password: "secret123"})

    assert_raise Ash.Error.Invalid, fn ->
      register!(%{username: "erin", password: "another"})
    end
  end
end
