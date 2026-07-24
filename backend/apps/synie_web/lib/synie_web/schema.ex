defmodule SynieWeb.Schema do
  use Absinthe.Schema
  use AshGraphql, domains: [SynieCore]

  object :session_user do
    field(:id, non_null(:id))
    field(:username, non_null(:string))
    field(:name, :string)
  end

  object :login_result do
    field(:token, non_null(:string))
    field(:user, non_null(:session_user))
  end

  object :permission_group do
    field(:prefix, non_null(:string))
    field(:label, non_null(:string))
    field(:actions, non_null(list_of(non_null(:string))))
  end

  # 明文密码仅在创建/重置的响应里出现一次,后端只存哈希,事后不可再查
  object :sys_user_with_password do
    field(:id, non_null(:id))
    field(:username, non_null(:string))
    field(:password, non_null(:string))
  end

  object :reset_password_result do
    field(:password, non_null(:string))
  end

  object :setup_status do
    field(:initialized, non_null(:boolean))
    field(:has_users, non_null(:boolean))
  end

  object :grid_enum_option do
    field(:value, non_null(:string))
    field(:label, non_null(:string))
  end

  object :grid_column_ref_variant do
    field(:value, non_null(:string))
    field(:resource, non_null(:string))
    field(:label_field, non_null(:string))
    field(:label, non_null(:string))
  end

  object :grid_column_ref do
    # 普通 fk:resource/relation/label_field 三件套;多态 fk 走 discriminator/variants,三件套为 null
    field(:resource, :string)
    field(:relation, :string)
    field(:label_field, :string)
    field(:discriminator, :string)
    # 判别列筛选字面量形态:"enum" 裸 token / "string" 带引号;仅多态 fk 有值
    field(:discriminator_type, :string)
    field(:variants, list_of(non_null(:grid_column_ref_variant)))
  end

  object :grid_column do
    field(:name, non_null(:string))
    field(:type, non_null(:string))
    field(:label, non_null(:string))
    field(:sortable, non_null(:boolean))
    field(:filterable, non_null(:boolean))
    field(:enum_options, list_of(non_null(:grid_enum_option)))
    field(:ref, :grid_column_ref)
  end

  object :grid_action do
    field(:key, non_null(:string))
    field(:label, non_null(:string))
    field(:scope, non_null(:string))
    field(:mutation, non_null(:string))
    field(:is_danger, non_null(:boolean))
  end

  object :grid_meta do
    field(:columns, non_null(list_of(non_null(:grid_column))))
    field(:capabilities, non_null(list_of(non_null(:string))))
    field(:extended_actions, non_null(list_of(non_null(:grid_action))))
    field(:destroy_mutation, :string)
  end

  object :numberable_resource do
    field(:prefix, non_null(:string))
    field(:grid, non_null(:string))
  end

  query do
    field :me, :session_user do
      resolve(fn _args, %{context: context} ->
        {:ok, session_user(context[:current_user])}
      end)
    end

    # 初始化向导状态:未认证可读(门控信息不含敏感数据,完成旗标落库后前端据此永久关闭入口)
    field :setup_status, non_null(:setup_status) do
      resolve(fn _args, _resolution ->
        {:ok, SynieCore.Setup.status()}
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
      resolve(fn _args, %{context: context} ->
        case context[:actor] do
          nil -> {:error, "未认证"}
          _actor -> {:ok, SynieCore.Authz.Registry.catalog()}
        end
      end)
    end

    field :grid_meta, non_null(:grid_meta) do
      arg(:resource, non_null(:string))

      resolve(fn %{resource: name}, %{context: context} ->
        SynieWeb.GridMeta.resolve(name, context[:actor])
      end)
    end

    # 可自动编号的资源清单:create action 挂了 AutoNumber 的白名单资源(编号规则页资源下拉)
    field :numberable_resources, non_null(list_of(non_null(:numberable_resource))) do
      resolve(fn _args, %{context: context} ->
        case context[:actor] do
          nil -> {:error, "未认证"}
          _actor -> {:ok, SynieWeb.GridMeta.numberable_resources()}
        end
      end)
    end
  end

  mutation do
    field :login, non_null(:login_result) do
      arg(:username, non_null(:string))
      arg(:password, non_null(:string))

      resolve(fn %{username: username, password: password}, %{context: context} ->
        bucket = login_bucket(username, context[:remote_ip])

        if SynieWeb.LoginRateLimiter.blocked?(bucket) do
          {:error, "登录尝试过于频繁,请稍后再试"}
        else
          case SynieCore.Accounts.authenticate(username, password) do
            {:ok, user} ->
              SynieWeb.LoginRateLimiter.reset(bucket)
              {:ok, %{token: SynieWeb.Auth.sign_token(user), user: session_user(user)}}

            {:error, :invalid_credentials} ->
              SynieWeb.LoginRateLimiter.record_failure(bucket)
              {:error, "用户名或密码错误"}
          end
        end
      end)
    end

    field :create_sys_user, non_null(:sys_user_with_password) do
      arg(:username, non_null(:string))
      arg(:name, :string)

      resolve(fn args, %{context: context} ->
        password = SynieCore.Accounts.generate_password()

        SynieCore.Accounts.User
        |> Ash.Changeset.for_create(:create, Map.put(args, :password, password),
          actor: context[:actor]
        )
        |> Ash.create()
        |> case do
          {:ok, user} ->
            {:ok, %{id: user.id, username: to_string(user.username), password: password}}

          {:error, error} ->
            {:error, mutation_error(error)}
        end
      end)
    end

    # 初始化向导:建首个用户(未认证可用,门面内按「未初始化且无用户」门控)并直接返回登录态
    field :setup_create_first_user, non_null(:login_result) do
      arg(:username, non_null(:string))
      arg(:name, :string)
      arg(:password, non_null(:string))

      resolve(fn args, _resolution ->
        case SynieCore.Setup.create_first_user(args) do
          {:ok, user} ->
            {:ok, %{token: SynieWeb.Auth.sign_token(user), user: session_user(user)}}

          {:error, error} ->
            {:error, mutation_error(error)}
        end
      end)
    end

    # 初始化向导:预置常用货币(登录即可,门面内按未初始化门控),返回新建条数
    field :setup_seed_common_currencies, non_null(:integer) do
      resolve(fn _args, %{context: context} ->
        case context[:actor] do
          nil ->
            {:error, "未认证"}

          _actor ->
            case SynieCore.Setup.seed_common_currencies() do
              {:ok, count} -> {:ok, count}
              {:error, error} -> {:error, mutation_error(error)}
            end
        end
      end)
    end

    # 初始化向导:选定本币后仅启用该币种(其余停用);须在建公司前调用
    field :setup_activate_only_base_currency, non_null(:boolean) do
      arg(:currency_id, non_null(:id))

      resolve(fn %{currency_id: currency_id}, %{context: context} ->
        case context[:actor] do
          nil ->
            {:error, "未认证"}

          _actor ->
            case SynieCore.Setup.activate_only_base_currency(currency_id) do
              :ok -> {:ok, true}
              {:error, error} -> {:error, mutation_error(error)}
            end
        end
      end)
    end

    # 初始化向导:完成(写首选语言+落完成旗标,落旗后 setup 接口永久关闭)
    # seed_sample_data:可选写入示例客商/物料/报价(依赖已建公司与完成时环境种子)
    field :setup_complete, non_null(:boolean) do
      arg(:preferred_language, non_null(:string))
      arg(:seed_sample_data, :boolean)

      resolve(fn args, %{context: context} ->
        language = args.preferred_language
        seed_sample? = Map.get(args, :seed_sample_data) == true

        case context[:actor] do
          nil ->
            {:error, "未认证"}

          actor ->
            case SynieCore.Setup.complete(actor, language, seed_sample_data: seed_sample?) do
              :ok -> {:ok, true}
              {:error, error} -> {:error, mutation_error(error)}
            end
        end
      end)
    end

    # 角色授权整组保存:以目标列表同步目录内具体码(通配/目录外存量码保留),返回同步后全部授权码
    field :sync_sys_role_permissions, non_null(list_of(non_null(:string))) do
      arg(:role_id, non_null(:id))
      arg(:permissions, non_null(list_of(non_null(:string))))

      resolve(fn %{role_id: role_id, permissions: permissions}, %{context: context} ->
        SynieCore.Authz.RolePermission
        |> Ash.ActionInput.for_action(
          :sync,
          %{role_id: role_id, permissions: permissions},
          actor: context[:actor]
        )
        |> Ash.run_action()
        |> case do
          {:ok, codes} -> {:ok, codes}
          {:error, error} -> {:error, mutation_error(error)}
        end
      end)
    end

    field :reset_sys_user_password, non_null(:reset_password_result) do
      arg(:id, non_null(:id))

      resolve(fn %{id: id}, %{context: context} ->
        actor = context[:actor]
        password = SynieCore.Accounts.generate_password()

        with {:ok, user} <- Ash.get(SynieCore.Accounts.User, id, actor: actor),
             {:ok, _user} <-
               user
               |> Ash.Changeset.for_update(:reset_password, %{password: password}, actor: actor)
               |> Ash.update() do
          {:ok, %{password: password}}
        else
          {:error, error} -> {:error, mutation_error(error)}
        end
      end)
    end
  end

  defp login_bucket(username, remote_ip), do: {username, remote_ip}

  defp mutation_error(%Ash.Error.Forbidden{}), do: "无权限执行该操作"

  defp mutation_error(error) when is_binary(error), do: error

  defp mutation_error(%{errors: errors}) when is_list(errors),
    do: Enum.map_join(errors, "; ", &sub_error_message/1)

  defp mutation_error(error), do: Exception.message(error)

  # 字段类子错误自带 field/message,优先用它;Exception.message 会带 Bread Crumbs 等内部噪音
  defp sub_error_message(%{field: field, message: message})
       when not is_nil(field) and is_binary(message),
       do: "#{field} #{message}"

  defp sub_error_message(error), do: Exception.message(error)

  defp session_user(nil), do: nil

  defp session_user(user) do
    %{id: user.id, username: to_string(user.username), name: user.name}
  end
end
