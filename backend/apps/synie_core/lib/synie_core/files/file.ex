defmodule SynieCore.Files.File.AttachmentGuard do
  @moduledoc "删除文件守卫:仍有业务挂接时拒绝(附件面板先删挂接再删文件的流程不受影响)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    attached? =
      SynieCore.Files.Attachment
      |> Ash.Query.filter(file_id == ^changeset.data.id)
      |> Ash.exists?(authorize?: false)

    template? =
      Code.ensure_loaded?(SynieCore.Printing.Template) and
        SynieCore.Printing.Template
        |> Ash.Query.filter(file_id == ^changeset.data.id)
        |> Ash.exists?(authorize?: false)

    cond do
      attached? ->
        {:error, message: "该文件仍有业务挂接,请先在业务单据中移除附件"}

      template? ->
        {:error, message: "该文件仍被打印模板引用,请先删除或更换模板"}

      true ->
        :ok
    end
  end
end

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
  def permission_label, do: "附件"
  def permission_actions, do: ~w(create read delete)

  # fk 速览标题用原始文件名(默认反射会取到 storage,对用户无意义)
  def display_field, do: :filename

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
      validate {SynieCore.Files.File.AttachmentGuard, []}
      change SynieCore.Files.DeleteStoredObject
    end
  end

  attributes do
    uuid_primary_key :id

    # 存储接入名,对应 sys_storage.name
    attribute :storage, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "存储接入"
    end

    # 服务端生成,不含用户输入
    attribute :key, :string do
      allow_nil? false
      public? true
      constraints max_length: 255
      description "对象键"
    end

    # 原始文件名仅展示,绝不拼路径
    attribute :filename, :string do
      allow_nil? false
      public? true
      constraints max_length: 255
      description "文件名"
    end

    attribute :content_type, :string do
      public? true
      constraints max_length: 128
      description "MIME 类型"
    end

    attribute :size, :integer do
      public? true
      description "大小"
    end

    # 留作校验/去重
    attribute :sha256, :string do
      public? true
      constraints max_length: 64
      description "SHA-256 摘要"
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
