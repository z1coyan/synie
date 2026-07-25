defmodule SynieCore.Sys.TodoState do
  @moduledoc """
  待办用户痕迹,对应 `sys_todo_state` 表。

  存个人交互:(todo_id, user_id) 唯一;活跃待办默认无痕迹行,已读/忽略时 upsert。
  忽略带复位基准(`reset_basis_at` = 忽略时的 `todo.source_changed_at`),
  源单状态变化产生新待办或基准漂移后自动失效。无独立权限、不进 GraphQL。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "sys_todo_state"
    repo SynieCore.Repo

    custom_indexes do
      index [:user_id]
    end

    references do
      reference :todo, on_delete: :delete
    end
  end

  # 仅内部 upsert,无公共动作
  policies do
    policy always() do
      authorize_if always()
    end
  end

  def permission_prefix, do: "sys.todo_state"
  def permission_actions, do: []

  actions do
    defaults [:read]

    create :create_internal do
      accept [:todo_id, :user_id, :read_at, :dismissed_at, :reset_basis_at]
    end

    update :upsert_internal do
      accept [:read_at, :dismissed_at, :reset_basis_at]
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :read_at, :utc_datetime_usec do
      description "已读时点"
    end

    attribute :dismissed_at, :utc_datetime_usec do
      description "忽略时点"
    end

    attribute :reset_basis_at, :utc_datetime_usec do
      description "忽略时的源单状态变化时点(复位基准)"
    end

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  relationships do
    belongs_to :todo, SynieCore.Sys.Todo do
      allow_nil? false
      attribute_writable? true
    end

    belongs_to :user, SynieCore.Accounts.User do
      allow_nil? false
      attribute_writable? true
    end
  end

  identities do
    identity :unique_todo_user, [:todo_id, :user_id]
  end
end
