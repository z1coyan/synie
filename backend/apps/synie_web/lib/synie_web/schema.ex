defmodule SynieWeb.Schema do
  use Absinthe.Schema
  use AshGraphql, domains: [SynieCore]

  object :session_user do
    field :id, non_null(:id)
    field :username, non_null(:string)
    field :name, :string
  end

  object :login_result do
    field :token, non_null(:string)
    field :user, non_null(:session_user)
  end

  object :permission_group do
    field :prefix, non_null(:string)
    field :actions, non_null(list_of(non_null(:string)))
  end

  query do
    field :me, :session_user do
      resolve(fn _args, %{context: context} ->
        {:ok, session_user(context[:current_user])}
      end)
    end

    field :my_permissions, non_null(list_of(non_null(:string))) do
      resolve(fn _args, %{context: context} ->
        case context[:actor] do
          nil -> {:ok, []}
          actor -> {:ok, SynieCore.Authz.Registry.granted_codes(actor)}
        end
      end)
    end

    field :permission_catalog, non_null(list_of(non_null(:permission_group))) do
      resolve(fn _args, _resolution ->
        {:ok, SynieCore.Authz.Registry.catalog()}
      end)
    end
  end

  mutation do
    field :login, non_null(:login_result) do
      arg(:username, non_null(:string))
      arg(:password, non_null(:string))

      resolve(fn %{username: username, password: password}, _resolution ->
        case SynieCore.Accounts.authenticate(username, password) do
          {:ok, user} ->
            {:ok, %{token: SynieWeb.Auth.sign_token(user), user: session_user(user)}}

          {:error, :invalid_credentials} ->
            {:error, "用户名或密码错误"}
        end
      end)
    end
  end

  defp session_user(nil), do: nil

  defp session_user(user) do
    %{id: user.id, username: to_string(user.username), name: user.name}
  end
end
