defmodule SynieCore.Files.File do
  @moduledoc """
  文件对象元数据,对应 `sys_file` 表。一行 = 一个物理存储对象;文件不可变,只增只删。
  `storage` 是配置名(见 `SynieCore.Storage`),bucket/endpoint 不入库。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_file"
    repo SynieCore.Repo
  end

  graphql do
    type :sys_file
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sys.file"
  def permission_actions, do: ~w(create read delete)

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    # 仅供 SynieCore.Files.upload/2 调用(storage/key 由服务端生成),不注册 GraphQL mutation
    create :create do
      accept [:storage, :key, :filename, :content_type, :size, :sha256, :uploaded_by_id]
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      change SynieCore.Files.DeleteStoredObject
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :storage, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "存储配置名(local/s3/oss...)"
    end

    attribute :key, :string do
      allow_nil? false
      public? true
      constraints max_length: 255
      description "对象键,服务端生成,不含用户输入"
    end

    attribute :filename, :string do
      allow_nil? false
      public? true
      constraints max_length: 255
      description "原始文件名(仅展示,绝不拼路径)"
    end

    attribute :content_type, :string do
      public? true
      constraints max_length: 128
      description "MIME 类型"
    end

    attribute :size, :integer do
      public? true
      description "字节数"
    end

    attribute :sha256, :string do
      public? true
      constraints max_length: 64
      description "内容摘要,留作校验/去重"
    end

    create_timestamp :inserted_at, public?: true, description: "上传时间"
  end

  relationships do
    belongs_to :uploaded_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上传人"
    end
  end
end
