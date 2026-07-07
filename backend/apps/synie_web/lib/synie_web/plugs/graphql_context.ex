defmodule SynieWeb.Plugs.GraphqlContext do
  @moduledoc """
  从 `Authorization: Bearer <token>` 解析当前用户,构建权限 actor,
  写入 Absinthe context(`current_user`、`actor`)并设置 Ash actor。
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case current_user(conn) do
      nil ->
        conn

      user ->
        actor = SynieCore.Authz.build_actor(user)

        conn
        |> Ash.PlugHelpers.set_actor(actor)
        |> Absinthe.Plug.put_options(context: %{current_user: user, actor: actor})
    end
  end

  defp current_user(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         {:ok, user_id} <- SynieWeb.Auth.verify_token(token) do
      SynieCore.Accounts.get_user(user_id)
    else
      _ -> nil
    end
  end
end
