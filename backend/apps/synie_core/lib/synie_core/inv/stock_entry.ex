defmodule SynieCore.Inv.StockEntry do
  @moduledoc """
  库存分录,对应 `inv_stock_entry` 表。库存领域唯一事实表:只追加、不可改,
  由库存来源单据审核时经 `SynieCore.Inv.Stock.post!/2` 派生(照 GlEntry 先例)。

  一行 = 一次「叶子仓×物料」的数量变动(一单据行派生一条,不合并);数量带符号
  (入正出负、非零),恒为物料默认单位口径,表上无单位字段。库存余额 = 未作废
  分录聚合(sum(quantity)),报表只查分录不查单据。

  用户无直接写入口:GraphQL 仅注册查询;`:create` 与 `:mark_cancelled` 仅供
  Inv.Stock 模块以 `authorize?: false` 调用。不挂审计 Fragment——分录本身即来源
  单据的审计产物,来源单据已接审计。作废不删数,仅标记 `is_cancelled`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    # 主 read 上的兜底排序(seq 升序)是有意为之,分录按发生顺序展示依赖此序
    primary_read_warning?: false

  postgres do
    table "inv_stock_entry"
    repo SynieCore.Repo

    check_constraints do
      check_constraint :quantity, "quantity_nonzero",
        check: "quantity <> 0",
        message: "数量不能为零"
    end

    custom_indexes do
      index [:company_id, :warehouse_id, :material_id, :posting_date]
      index [:voucher_type, :voucher_id]
    end
  end

  graphql do
    type :inv_stock_entry
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 库存余额表是读能力的衍生视图,复用 read 码不新设权限点;
    # 公司数据权限在实现内手动检查(泛型动作不走 CompanyScope)
    policy action(:stock_balance) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "read"}
    end

    policy action_type([:read, :create, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "inv.stock_entry"
  def permission_actions, do: ~w(read)

  # 来源单据是多态引用(判别列 + 裸 uuid、无 belongs_to),声明给 GridMeta 反射成多态 fk 列
  def poly_refs do
    %{
      voucher_id: %{
        discriminator: :voucher_type,
        variants: SynieCore.Inv.Stock.voucher_resources()
      }
    }
  end

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare build(sort: [seq: :asc])
    end

    # 仅内部(Inv.Stock.post!)使用,GraphQL 不注册 mutation
    create :create do
      accept [
        :company_id,
        :warehouse_id,
        :material_id,
        :quantity,
        :posting_date,
        :voucher_type,
        :voucher_id,
        :voucher_no,
        :remarks
      ]
    end

    # 仅内部(Inv.Stock.cancel!)使用:作废来源单据时批量标记
    update :mark_cancelled do
      accept []
      change set_attribute(:is_cancelled, true)
    end

    action :stock_balance, {:array, :map} do
      description "库存余额表:公司下仓×物料聚合(未作废分录、业务日期 ≤ 截至日;hide_zero 缺省隐藏零行)"

      argument :company_id, :uuid, allow_nil?: false
      argument :as_of, :date
      argument :warehouse_id, :uuid
      argument :material_id, :uuid
      argument :hide_zero, :boolean

      run SynieCore.Inv.StockBalance
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :seq, :integer do
      allow_nil? false
      writable? false
      generated? true
      public? true
      description "序号"
    end

    attribute :quantity, :decimal do
      allow_nil? false
      public? true
      description "数量(带符号,入正出负,物料默认单位口径)"
    end

    attribute :posting_date, :date do
      allow_nil? false
      public? true
      description "业务日期"
    end

    attribute :voucher_type, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "来源单据类型"
    end

    attribute :voucher_id, :uuid do
      allow_nil? false
      public? true
      description "来源单据"
    end

    attribute :voucher_no, :string do
      allow_nil? false
      public? true
      constraints max_length: 64
      description "来源单据编号"
    end

    attribute :is_cancelled, :boolean do
      allow_nil? false
      default false
      public? true
      description "已作废"
    end

    attribute :remarks, :string do
      public? true
      constraints max_length: 512
      description "摘要"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :warehouse, SynieCore.Inv.Warehouse do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "仓库"
    end

    belongs_to :material, SynieCore.Inv.Material do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "物料"
    end
  end
end
