defmodule SynieCore.Files.StorageEndpoint.KindFields do
  @moduledoc "按 kind 校验配置必填:local 要 root;s3/oss 要 endpoint/bucket/access_key_id/secret_access_key。"

  use Ash.Resource.Validation

  @labels %{
    root: "根目录",
    endpoint: "服务地址",
    bucket: "Bucket",
    access_key_id: "Access Key ID",
    secret_access_key: "Secret Access Key"
  }

  @impl true
  def validate(changeset, _opts, _context) do
    case Ash.Changeset.get_attribute(changeset, :kind) do
      :local ->
        require_fields(changeset, [:root])

      kind when kind in [:s3, :oss] ->
        require_fields(changeset, [:endpoint, :bucket, :access_key_id, :secret_access_key])

      _ ->
        :ok
    end
  end

  defp require_fields(changeset, fields) do
    case Enum.find(fields, &blank?(Ash.Changeset.get_attribute(changeset, &1))) do
      nil -> :ok
      field -> {:error, field: field, message: "该存储类型下「#{@labels[field]}」必填"}
    end
  end

  defp blank?(nil), do: true
  defp blank?(v) when is_binary(v), do: String.trim(v) == ""
end

defmodule SynieCore.Files.StorageEndpoint.SetDefault do
  @moduledoc "设为全局默认:先清其他行 is_default 再置本行(顺序保证 partial unique index 不瞬时冲突)。"

  use Ash.Resource.Change

  require Ash.Query

  @impl true
  def change(changeset, _opts, _context) do
    changeset
    |> Ash.Changeset.before_action(fn changeset ->
      # 旧默认至多一行,逐行 update 走审计,不用 bulk(审计资源流式 bulk 受限)
      SynieCore.Files.StorageEndpoint
      |> Ash.Query.filter(is_default == true and id != ^changeset.data.id)
      |> Ash.read!(authorize?: false)
      |> Enum.each(fn ep ->
        ep
        |> Ash.Changeset.for_update(:unset_default, %{})
        |> Ash.update!(authorize?: false)
      end)

      changeset
    end)
    |> Ash.Changeset.force_change_attribute(:is_default, true)
  end
end

defmodule SynieCore.Files.StorageEndpoint.DestroyGuard do
  @moduledoc "删除守卫:内置/默认/仍有文件引用的接入点不可删。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    data = changeset.data

    cond do
      data.builtin -> {:error, message: "内置存储接入不可删除"}
      data.is_default -> {:error, message: "默认存储接入不可删除,请先将其他接入点设为默认"}
      has_files?(data.name) -> {:error, message: "仍有文件存于该接入点,不可删除"}
      true -> :ok
    end
  end

  defp has_files?(name) do
    SynieCore.Files.File
    |> Ash.Query.filter(storage == ^name)
    |> Ash.exists?(authorize?: false)
  end
end

defmodule SynieCore.Files.StorageEndpoint do
  @moduledoc """
  存储接入点,对应 `sys_storage` 表。`name` 即 `sys_file.storage` 的配置名,建后不可改;
  `kind` 决定 adapter(local/s3/oss)。全局默认唯一(partial unique index),新上传落到默认
  接入点;内置 local 行由 seeds 创建,不可删除。密钥只写不回读:GraphQL 不暴露,update 留空表示不修改。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_storage"
    repo SynieCore.Repo

    custom_indexes do
      index [:is_default],
        unique: true,
        where: "is_default",
        name: "sys_storage_single_default_index"
    end
  end

  graphql do
    type :sys_storage
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # 设默认是管理动作,复用 update 码不新设权限点;unset_default 仅 SetDefault 内部路径调用
    policy action([:set_default, :unset_default]) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "update"}
    end
  end

  def permission_prefix, do: "sys.storage"
  def permission_actions, do: ~w(create read update delete)

  def display_field, do: :label

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
      accept [
        :name,
        :label,
        :kind,
        :root,
        :endpoint,
        :region,
        :bucket,
        :prefix,
        :access_key_id
      ]

      # 密钥只写不回读(public? false 不进 accept/GraphQL),经 argument 写入;nil/空串 = 不修改
      argument :secret_access_key, :string

      change fn changeset, _context ->
        case Ash.Changeset.get_argument(changeset, :secret_access_key) do
          nil -> changeset
          "" -> changeset
          secret -> Ash.Changeset.force_change_attribute(changeset, :secret_access_key, secret)
        end
      end

      validate match(:name, ~r/^[a-z0-9][a-z0-9_-]*$/),
        message: "接入名只能用小写字母、数字、中划线、下划线,且以字母或数字开头"

      validate {SynieCore.Files.StorageEndpoint.KindFields, []}
    end

    update :update do
      # name(已入库文件引用)与 kind(决定 adapter/配置形态)建后不可改
      accept [
        :label,
        :root,
        :endpoint,
        :region,
        :bucket,
        :prefix,
        :access_key_id
      ]

      argument :secret_access_key, :string

      change fn changeset, _context ->
        case Ash.Changeset.get_argument(changeset, :secret_access_key) do
          nil -> changeset
          "" -> changeset
          secret -> Ash.Changeset.force_change_attribute(changeset, :secret_access_key, secret)
        end
      end

      require_atomic? false

      validate {SynieCore.Files.StorageEndpoint.KindFields, []}
    end

    update :set_default do
      accept []
      require_atomic? false
      change SynieCore.Files.StorageEndpoint.SetDefault
    end

    # 仅供 SetDefault 清旧默认,不注册 GraphQL
    update :unset_default do
      accept []
      require_atomic? false
      change set_attribute(:is_default, false)
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      validate {SynieCore.Files.StorageEndpoint.DestroyGuard, []}
    end
  end

  attributes do
    uuid_primary_key :id

    # name 写入 sys_file.storage,建后不可改(update 不 accept)
    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "接入名"
    end

    attribute :label, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "显示名"
    end

    attribute :kind, SynieCore.Files.StorageKind do
      allow_nil? false
      public? true
      description "存储类型"
    end

    # local 用;相对路径由 adapter 按后端工作目录展开
    attribute :root, :string do
      public? true
      constraints max_length: 255
      description "根目录"
    end

    attribute :endpoint, :string do
      public? true
      constraints max_length: 255
      description "服务地址"
    end

    # 可空,S3 签名兜底 us-east-1
    attribute :region, :string do
      public? true
      constraints max_length: 64
      description "区域"
    end

    attribute :bucket, :string do
      public? true
      constraints max_length: 128
      description "Bucket"
    end

    # 可空,对象存储的「默认路径」,拼在服务端 key 前
    attribute :prefix, :string do
      public? true
      constraints max_length: 128
      description "对象键前缀"
    end

    attribute :access_key_id, :string do
      public? true
      constraints max_length: 128
      description "Access Key ID"
    end

    attribute :secret_access_key, :string do
      public? false
      sensitive? true
      constraints max_length: 128
      description "Secret Access Key"
    end

    attribute :builtin, :boolean do
      allow_nil? false
      public? true
      default false
      writable? false
      description "内置"
    end

    attribute :is_default, :boolean do
      allow_nil? false
      public? true
      default false
      writable? false
      description "全局默认"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_name, [:name], message: "接入名已存在"
  end
end
