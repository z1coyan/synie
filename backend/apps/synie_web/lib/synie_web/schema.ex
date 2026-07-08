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

  object :grid_enum_option do
    field :value, non_null(:string)
    field :label, non_null(:string)
  end

  object :grid_column do
    field :name, non_null(:string)
    field :type, non_null(:string)
    field :label, non_null(:string)
    field :sortable, non_null(:boolean)
    field :filterable, non_null(:boolean)
    field :enum_options, list_of(non_null(:grid_enum_option))
  end

  object :grid_action do
    field :key, non_null(:string)
    field :label, non_null(:string)
    field :scope, non_null(:string)
    field :mutation, non_null(:string)
    field :is_danger, non_null(:boolean)
  end

  object :grid_meta do
    field :columns, non_null(list_of(non_null(:grid_column)))
    field :capabilities, non_null(list_of(non_null(:string)))
    field :extended_actions, non_null(list_of(non_null(:grid_action)))
    field :destroy_mutation, :string
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

    field :grid_meta, non_null(:grid_meta) do
      arg(:resource, non_null(:string))

      resolve(fn %{resource: name}, %{context: context} ->
        SynieWeb.GridMeta.resolve(name, context[:actor])
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
