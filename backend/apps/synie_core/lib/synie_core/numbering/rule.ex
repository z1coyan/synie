defmodule SynieCore.Numbering.ResetPeriod do
  @moduledoc "编号重置周期:不重置/按年/按月/按日。"

  use Ash.Type.Enum, values: [never: "不重置", yearly: "按年", monthly: "按月", daily: "按日"]

  def graphql_type(_), do: :sys_numbering_reset_period
end

defmodule SynieCore.Numbering.Rule do
  @moduledoc """
  编号规则,对应 `sys_numbering_rule` 表。

  格式模板 token:`{company}`(公司编码)、`{YYYY}` `{YY}` `{MM}` `{DD}`(取号日期)、
  `{seq}`(序号,按 seq_padding 补零)。取号入口见 `SynieCore.Numbering.next/2`。
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
  end

  graphql do
    type :sys_numbering_rule
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
      accept [:code, :name, :format, :seq_padding, :reset_period, :per_company, :enabled]
    end

    update :update do
      accept [:name, :format, :seq_padding, :reset_period, :per_company, :enabled]
      require_atomic? false
    end

    destroy :destroy do
      primary? true
      require_atomic? false
    end
  end

  validations do
    # 模板缺 {seq} 会导致重号(靠业务表唯一键兜底才炸),建/改时直接挡
    validate match(:format, ~r/\{seq\}/) do
      message "格式模板必须包含 {seq} 序号占位"
      where [changing(:format)]
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "规则标识"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "规则名称"
    end

    attribute :format, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "格式模板"
    end

    attribute :seq_padding, :integer do
      allow_nil? false
      public? true
      default 4
      constraints min: 1, max: 12
      description "序号位数"
    end

    attribute :reset_period, SynieCore.Numbering.ResetPeriod do
      allow_nil? false
      public? true
      default :monthly
      description "重置周期"
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

  identities do
    identity :unique_code, [:code]
  end
end
