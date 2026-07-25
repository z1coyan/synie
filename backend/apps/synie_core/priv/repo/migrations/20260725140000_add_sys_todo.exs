defmodule SynieCore.Repo.Migrations.AddSysTodo do
  @moduledoc """
  待办设施地基(ADR 2026-07-25):物化待办表 + 个人痕迹表。

  - sys_todo:对账单确认态派生的开票/收票提醒,同事务写关
  - sys_todo_state:已读/忽略个人痕迹;(todo_id, user_id) 唯一
  - 部分唯一索引兜底「一张源单据同一时刻至多一条 active 待办」
  """

  use Ecto.Migration

  def up do
    create table(:sys_todo, primary_key: false) do
      add :id, :uuid, null: false, default: fragment("gen_random_uuid()"), primary_key: true
      add :type, :text, null: false
      add :source_type, :text, null: false
      add :source_id, :uuid, null: false
      add :source_no, :text, null: false
      add :party_type, :text, null: false
      add :party_id, :uuid, null: false
      add :amount, :decimal, null: false, default: "0"
      add :status, :text, null: false, default: "active"
      add :closed_reason, :text
      add :source_changed_at, :utc_datetime_usec, null: false
      add :closed_at, :utc_datetime_usec

      add :inserted_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :updated_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :company_id,
          references(:bas_company,
            column: :id,
            name: "sys_todo_company_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false

      add :created_by_id,
          references(:sys_user,
            column: :id,
            name: "sys_todo_created_by_id_fkey",
            type: :uuid,
            prefix: "public"
          )
    end

    create index(:sys_todo, [:company_id, :status, :inserted_at],
             name: "sys_todo_company_status_inserted_at_index"
           )

    create index(:sys_todo, [:source_type, :source_id], name: "sys_todo_source_index")

    # 一张源单据同一时刻至多一条 active 待办
    create unique_index(:sys_todo, [:source_type, :source_id],
             where: "status = 'active'",
             name: "sys_todo_one_active_per_source_index"
           )

    create table(:sys_todo_state, primary_key: false) do
      add :id, :uuid, null: false, default: fragment("gen_random_uuid()"), primary_key: true
      add :read_at, :utc_datetime_usec
      add :dismissed_at, :utc_datetime_usec
      # 忽略时快照的源单状态变化时点;与 todo.source_changed_at 一致时忽略生效
      add :reset_basis_at, :utc_datetime_usec

      add :inserted_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :updated_at, :utc_datetime_usec,
        null: false,
        default: fragment("(now() AT TIME ZONE 'utc')")

      add :todo_id,
          references(:sys_todo,
            column: :id,
            name: "sys_todo_state_todo_id_fkey",
            type: :uuid,
            prefix: "public",
            on_delete: :delete_all
          ),
          null: false

      add :user_id,
          references(:sys_user,
            column: :id,
            name: "sys_todo_state_user_id_fkey",
            type: :uuid,
            prefix: "public"
          ),
          null: false
    end

    create unique_index(:sys_todo_state, [:todo_id, :user_id],
             name: "sys_todo_state_todo_id_user_id_index"
           )

    create index(:sys_todo_state, [:user_id], name: "sys_todo_state_user_id_index")
  end

  def down do
    drop_if_exists index(:sys_todo_state, [:user_id], name: "sys_todo_state_user_id_index")

    drop_if_exists unique_index(:sys_todo_state, [:todo_id, :user_id],
                     name: "sys_todo_state_todo_id_user_id_index"
                   )

    drop_if_exists table(:sys_todo_state)

    drop_if_exists unique_index(:sys_todo, [:source_type, :source_id],
                     name: "sys_todo_one_active_per_source_index"
                   )

    drop_if_exists index(:sys_todo, [:source_type, :source_id], name: "sys_todo_source_index")

    drop_if_exists index(:sys_todo, [:company_id, :status, :inserted_at],
                     name: "sys_todo_company_status_inserted_at_index"
                   )

    drop_if_exists table(:sys_todo)
  end
end
