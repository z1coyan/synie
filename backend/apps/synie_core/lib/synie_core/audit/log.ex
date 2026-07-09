defmodule SynieCore.Audit.Log do
  @moduledoc """
  审计日志,对应 `sys_audit_log` 表。

  仅由 `SynieCore.Audit.Track` 经 `:record` 动作内部写入(`authorize?: false`),
  对外只读;只增不改不删。`changes` 格式:`%{"字段" => %{"from" => 旧, "to" => 新}}`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    # 主 read 动作上的 sort 是有意为之(按时间倒序),非误用,关闭该项误报警告
    primary_read_warning?: false

  postgres do
    table "sys_audit_log"
    repo SynieCore.Repo

    custom_indexes do
      index [:resource, :record_id, :inserted_at]
      index [:inserted_at]
    end
  end

  graphql do
    type :sys_audit_log
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 公司日志按授权公司过滤(fail-closed);全局资源日志(company_id 为空)不受限
    policy action_type(:read) do
      authorize_if expr(is_nil(company_id))
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "sys.audit_log"
  def permission_actions, do: ~w(read)

  actions do
    read :read do
      primary? true
      pagination offset?: true, countable: true, required?: false, default_limit: 50
      prepare build(sort: [inserted_at: :desc])
    end

    # 仅供 Audit.Track 内部调用,不暴露 GraphQL mutation
    create :record do
      accept [
        :resource,
        :record_id,
        :record_label,
        :action_type,
        :action_name,
        :actor_id,
        :actor_name,
        :company_id,
        :changes
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
    end
  end

  attributes do
    uuid_primary_key :id

    # 声明在最前:GridMeta 列序即属性声明序,审计日志按惯例时间列在首
    create_timestamp :inserted_at, public?: true, description: "操作时间"

    attribute :resource, :string do
      allow_nil? false
      public? true
      description "资源"
    end

    attribute :record_id, :uuid do
      allow_nil? false
      public? true
      description "记录ID"
    end

    # 记录展示名(资源的 name 属性),记录删除后仍可显示
    attribute :record_label, :string do
      public? true
      description "记录名称"
    end

    attribute :action_type, :string do
      allow_nil? false
      public? true
      description "操作类型"
    end

    attribute :action_name, :string do
      allow_nil? false
      public? true
      description "动作"
    end

    attribute :actor_id, :uuid do
      public? true
      description "操作人ID"
    end

    attribute :actor_name, :string do
      public? true
      description "操作人"
    end

    attribute :company_id, :uuid do
      public? true
      description "公司ID"
    end

    attribute :changes, :map do
      allow_nil? false
      public? true
      description "变更内容"
    end
  end
end
