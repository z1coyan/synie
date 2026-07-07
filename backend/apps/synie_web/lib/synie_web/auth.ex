defmodule SynieWeb.Auth do
  @moduledoc "登录令牌的签发与校验(基于 Phoenix.Token)。"

  @salt "synie user auth"
  @max_age 7 * 24 * 60 * 60

  @spec sign_token(SynieCore.Accounts.User.t()) :: String.t()
  def sign_token(user) do
    Phoenix.Token.sign(SynieWeb.Endpoint, @salt, user.id)
  end

  @spec verify_token(String.t()) :: {:ok, String.t()} | {:error, atom()}
  def verify_token(token) do
    Phoenix.Token.verify(SynieWeb.Endpoint, @salt, token, max_age: @max_age)
  end
end
