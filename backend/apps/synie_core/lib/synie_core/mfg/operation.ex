defmodule SynieCore.Mfg.Operation.NotReferenced do
  @moduledoc "被 BOM 工艺路线行或工艺模板行引用的工序禁止删除(见 BOM 模块 ADR:被引用后不可删)。"

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    id = changeset.data.id

    route_hit? =
      SynieCore.Mfg.BomRoute
      |> Ash.Query.filter(operation_id == ^id)
      |> Ash.exists?(authorize?: false)

    template_hit? =
      SynieCore.Mfg.ProcessTemplateItem
      |> Ash.Query.filter(operation_id == ^id)
      |> Ash.exists?(authorize?: false)

    if route_hit? or template_hit? do
      {:error, message: "工序已被工艺路线或工艺模板引用,不能删除"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Mfg.Operation do
  @moduledoc """
  工序,对应 `mfg_operation` 表。全局共享的工序主数据(不分公司),
  冲网/分切/焊接/CNC 等稳定词汇收口为主数据,BOM 工艺路线行与工艺模板行引用;
  被引用后不可删除(见 `NotReferenced`)。

  编号留空按 `mfg.operation` 编号规则自动取号(AutoNumber),手填原样保留;
  创建后不可修改(同物料/行情品种先例)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  postgres do
    table "mfg_operation"
    repo SynieCore.Repo
  end

  graphql do
    type :mfg_operation
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end
  end

  def permission_prefix, do: "mfg.operation"
  def permission_label, do: "工序"
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
      primary? true
      require_atomic? false

      validate {SynieCore.Mfg.Operation.NotReferenced, []}
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :code, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "工序编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "工序名称"
    end

    attribute :note, :string do
      public? true
      constraints max_length: 255
      description "备注"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  identities do
    identity :unique_code, [:code], message: "工序编号已存在"
  end
end
