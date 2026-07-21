defmodule SynieCore.Numbering.Rule.ValidateSegments do
  @moduledoc "校验段列表结构与字段可解析性(委托 Numbering.validate_segments/2)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    prefix = Ash.Changeset.get_attribute(changeset, :resource)
    segments = Ash.Changeset.get_attribute(changeset, :segments)

    case SynieCore.Numbering.validate_segments(prefix, segments) do
      :ok -> :ok
      {:error, message} -> {:error, field: :segments, message: message}
    end
  end
end

defmodule SynieCore.Numbering.Rule.OneEnabledPerResource do
  @moduledoc """
  每资源至多一条启用规则(取号无歧义)。构建期校验给友好报错;
  并发窗口由 DB partial unique index(resource where enabled)兜底。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    if Ash.Changeset.get_attribute(changeset, :enabled) do
      prefix = Ash.Changeset.get_attribute(changeset, :resource)

      SynieCore.Numbering.Rule
      |> Ash.Query.filter(resource == ^prefix and enabled == true)
      |> then(fn query ->
        case changeset.data.id do
          nil -> query
          id -> Ash.Query.filter(query, id != ^id)
        end
      end)
      |> Ash.read!(authorize?: false)
      |> case do
        [] -> :ok
        _ -> {:error, field: :enabled, message: "该资源已有启用的编号规则,同一资源只能启用一条"}
      end
    else
      :ok
    end
  end
end

defmodule SynieCore.Numbering.Rule do
  @moduledoc """
  编号规则,对应 `sys_numbering_rule` 表。规则绑定资源(`resource` = 权限码前缀,
  如 `acc.gl_journal`),内容是有序段列表 `segments`(jsonb,string key):

  - `%{"type" => "text", "value" => "记"}` — 固定文本
  - `%{"type" => "field", "field" => "company.code"}` — 记录字段(支持 belongs_to 一级字段);
    date/datetime 字段须带 `"format"`(YYYY/YY/MM/DD 组合)
  - `%{"type" => "seq", "padding" => 4}` — 序号,恰好一个;`padding` 0=不补零,1..12 补零

  字段段取值为空时省略该段。计数范围 = 渲染后的非 seq 段文本(+按公司维度),
  无独立重置周期——段里引用的日期格式变了 key 自然变、序号自然从头计。
  取号入口见 `SynieCore.Numbering.next/1`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_numbering_rule"
    repo SynieCore.Repo

    custom_indexes do
      # 每资源至多一条启用规则(应用层校验的并发兜底)
      index [:resource],
        unique: true,
        where: "enabled",
        name: "sys_numbering_rule_one_enabled_per_resource_index"
    end
  end

  graphql do
    type :sys_numbering_rule

    # 段列表整体按 JSON 串收发(同审计日志 changes 先例),前端一次 parse/stringify
    attribute_types segments: :json_string
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "sys.numbering_rule"
  def permission_label, do: "编号规则"
  def permission_actions, do: ~w(create read update delete)

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
      accept [:resource, :name, :segments, :per_company, :enabled]

      validate {SynieCore.Numbering.Rule.ValidateSegments, []}
      validate {SynieCore.Numbering.Rule.OneEnabledPerResource, []}
    end

    update :update do
      accept [:name, :segments, :per_company, :enabled]
      require_atomic? false

      validate {SynieCore.Numbering.Rule.ValidateSegments, []}
      validate {SynieCore.Numbering.Rule.OneEnabledPerResource, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :resource, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "绑定资源"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "规则名称"
    end

    attribute :segments, {:array, :map} do
      allow_nil? false
      public? true
      description "编号段"
    end

    attribute :per_company, :boolean do
      allow_nil? false
      public? true
      default true
      description "按公司计数"
    end

    attribute :enabled, :boolean do
      allow_nil? false
      public? true
      default true
      description "启用"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end
end
