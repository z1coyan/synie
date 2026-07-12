defmodule SynieCore.Files.Attachment do
  @moduledoc """
  业务记录-文件关联,对应 `sys_attachment` 表。
  业务表零改动:靠 `owner_type`(graphql type 名)+ `owner_id` 多态引用,
  `category` 区分一张单据上的多组附件槽位。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_attachment"
    repo SynieCore.Repo

    custom_indexes do
      index [:owner_type, :owner_id]

      # 公司隔离读走 CompanyScope 的 company_id in ^ids,为将来量大后的过滤建索引
      index [:company_id]
    end
  end

  graphql do
    type :sys_attachment
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 附件是文件的关联维度,不设独立权限点,全部跟随 sys.file
    policy action(:create) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action(:destroy) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "delete"}
    end

    # 读:先 sys.file:read,再照 sys_audit_log 做 fail-closed 公司隔离
    # (全局宿主附件 company_id 为空,不受限;公司宿主附件按授权公司过滤)
    policy action(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action(:read) do
      authorize_if expr(is_nil(company_id))
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "sys.file"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      # company_id 由 SynieCore.Files.maybe_attach 从宿主去规范化写入;
      # 本 create 不注册 GraphQL mutation,accept 它安全
      accept [:file_id, :owner_type, :owner_id, :category, :company_id]
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :owner_type, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "宿主资源标识(graphql type 名,如 sal_customer)"
    end

    attribute :owner_id, :uuid do
      allow_nil? false
      public? true
      description "宿主记录 id"
    end

    attribute :category, :string do
      allow_nil? false
      public? true
      default "default"
      constraints max_length: 32
      description "业务槽位(如 contract/invoice)"
    end

    attribute :company_id, :uuid do
      public? true

      description "去规范化自宿主记录的公司;全局宿主(如客户)为空。照 sys_audit_log 做 fail-closed 公司隔离。"
    end

    create_timestamp :inserted_at, public?: true, description: "挂接时间"
  end

  relationships do
    belongs_to :file, SynieCore.Files.File do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "文件对象"
    end
  end
end
