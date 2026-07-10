defmodule SynieCore.Numbering.Counter do
  @moduledoc """
  编号计数器,对应 `sys_numbering_counter` 表,行由取号自动创建(`SynieCore.Numbering.next/2`
  内部 upsert,不走本资源)。`scope_key` 为 `公司编码|周期`(如 `A|202607`,不按公司为 `-`)。
  只开 read/update:页面可查看并调整当前序号,调整走 Ash 有审计留痕。
  无独立权限点:permission_actions 为空(不进权限目录),动作复用 `sys.numbering_rule` 权限码。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "sys_numbering_counter"
    repo SynieCore.Repo

    references do
      # 删规则 DB 级联删计数器(计数器不留单独审计,规则删除本身已审计)
      reference :rule, on_delete: :delete
    end
  end

  graphql do
    type :sys_numbering_counter
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  # 复用规则权限码;actions 为空不进权限目录(同 GlJournalLine 跟随 acc.gl_journal 的先例)
  def permission_prefix, do: "sys.numbering_rule"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [scope_key: :asc])
    end

    update :update do
      accept [:value]
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :scope_key, :string do
      allow_nil? false
      public? true
      writable? false
      constraints max_length: 64
      description "计数范围"
    end

    attribute :value, :integer do
      allow_nil? false
      public? true
      default 0
      constraints min: 0
      description "当前序号"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :rule, SynieCore.Numbering.Rule do
      allow_nil? false
      public? true
      attribute_public? true
      description "编号规则"
    end
  end

  identities do
    identity :unique_scope_per_rule, [:rule_id, :scope_key]
  end
end
