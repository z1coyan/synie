defmodule SynieCore.Accounts do
  @moduledoc "账号相关的领域服务。"

  alias SynieCore.Accounts.User

  @doc """
  按用户名 + 明文密码认证。

  成功返回 `{:ok, user}`,失败统一返回 `{:error, :invalid_credentials}`,
  不区分「用户不存在」与「密码错误」,并对不存在的用户做等时哈希以防时序探测。
  """
  @spec authenticate(String.t(), String.t()) :: {:ok, User.t()} | {:error, :invalid_credentials}
  def authenticate(username, password) when is_binary(username) and is_binary(password) do
    user =
      User
      |> Ash.Query.for_read(:by_username, %{username: username})
      |> Ash.read_one!()

    cond do
      is_nil(user) ->
        Pbkdf2.no_user_verify()
        {:error, :invalid_credentials}

      Pbkdf2.verify_pass(password, user.hashed_password) ->
        {:ok, user}

      true ->
        {:error, :invalid_credentials}
    end
  end

  @doc "按主键取用户,不存在时返回 `nil`。"
  @spec get_user(String.t()) :: User.t() | nil
  def get_user(id) do
    case Ash.get(User, id) do
      {:ok, user} -> user
      {:error, _} -> nil
    end
  end
end
