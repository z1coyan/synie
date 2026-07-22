defmodule SynieCore.Mfg.ProcessTemplate do
  @moduledoc """
  工艺模板,对应 `mfg_process_template` 表。独立可维护的工艺路线模板主数据,
  全局共享(不分公司);建 BOM 工艺路线时选模板复制带入为 BOM 私行,
  此后模板再改不影响已建 BOM(快照语义,见 BOM 模块 ADR)。模板行见 `ProcessTemplateItem`。

  编号留空按 `mfg.route_template` 编号规则自动取号(AutoNumber),手填原样保留;
  创建后不可修改。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_process_template"
    repo SynieCore.Repo
  end

  graphql do
    type :mfg_process_template
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "mfg.route_template"
  def permission_label, do: "工艺模板"
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
      accept [:code, :name, :note]

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :code}
    end

    update :update do
      # 不接受 :code:编号创建后不可修改
      accept [:name, :note]
      require_atomic? false
    end

    destroy :destroy do
      # 模板行随模板级联删(DB reference on_delete: :delete)
      primary? true
      require_atomic? false
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "模板编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "模板名称"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    has_many :items, SynieCore.Mfg.ProcessTemplateItem do
      destination_attribute :template_id
    end
  end

  identities do
    identity :unique_code, [:code], message: "工艺模板编号已存在"
  end
end
