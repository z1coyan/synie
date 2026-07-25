defmodule SynieCore.Scm.FlowType do
  @moduledoc "收发货单据类型:采购入库/委外发料/委外入库/销售发货(未来退货等在此扩展)。"

  use Ash.Type.Enum,
    values: [
      purchase_receipt: "采购入库",
      outsourced_issue: "委外发料",
      outsourced_receipt: "委外入库",
      sales_delivery: "销售发货"
    ]

  def graphql_type(_), do: :scm_flow_type
end

defmodule SynieCore.Scm.OrderFlowStatus do
  @moduledoc "收发货单据状态:草稿/已审核/已作废。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]

  def graphql_type(_), do: :scm_order_flow_status
end

defmodule SynieCore.Scm.OrderFlowItem do
  @moduledoc """
  订单收发货历史行,对应只读视图 `scm_order_flow_item`(ADR 2026-07-25)。

  UNION ALL 采购入库、委外发料、委外入库、销售发货四类单据行的统一视角,
  供销售/采购订单抽屉「收发货历史」tab 单表展示;列全走行上快照/头投影,
  不暴露会触发嵌套授权的 fk。未来退货等单据类型:扩展视图 + `FlowType` 枚举即可。

  只读资源,无写动作不设权限点;读门槛 = 持有任一来源单据 read 权限
  (purchase.receipt / purchase.outsourced_issue / purchase.outsourced_receipt /
  sales.delivery 任一),公司维度照常 CompanyScope 数据权限。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    primary_read_warning?: false

  postgres do
    table "scm_order_flow_item"
    repo SynieCore.Repo
  end

  graphql do
    type :scm_order_flow_item
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    # 任一来源单据 read 权限即可读(历史行信息不超出各单据条目页已有口径)
    policy action_type(:read) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, code: "purchase.receipt:read"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, code: "purchase.outsourced_issue:read"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, code: "purchase.outsourced_receipt:read"}
      authorize_if {SynieCore.Authz.Checks.HasPermission, code: "sales.delivery:read"}
    end

    policy action_type(:read) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  # 复用来源单据权限码(见 policies),不进权限目录
  def permission_prefix, do: "scm.order_flow"
  def permission_actions, do: []

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200

      prepare fn query, _context ->
        if Enum.empty?(query.sort) do
          Ash.Query.sort(query, voucher_date: :desc, id: :asc)
        else
          query
        end
      end
    end
  end

  attributes do
    attribute :id, :string do
      primary_key? true
      allow_nil? false
      writable? false
      public? true
      description "行标识(单据类型:来源行 id)"
    end

    attribute :flow_type, SynieCore.Scm.FlowType do
      allow_nil? false
      writable? false
      public? true
      description "单据类型"
    end

    attribute :voucher_no, :string do
      allow_nil? false
      writable? false
      public? true
      description "单据编号"
    end

    attribute :voucher_date, :date do
      allow_nil? false
      writable? false
      public? true
      description "单据日期"
    end

    attribute :status, SynieCore.Scm.OrderFlowStatus do
      allow_nil? false
      writable? false
      public? true
      description "单据状态"
    end

    attribute :qty, :decimal do
      allow_nil? false
      writable? false
      public? true
      description "数量"
    end

    # 物料快照
    attribute :material_code, :string do
      allow_nil? false
      writable? false
      public? true
      description "物料编号"
    end

    attribute :material_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "物料名称"
    end

    attribute :material_spec, :string do
      writable? false
      public? true
      description "规格"
    end

    attribute :customer_part_no, :string do
      writable? false
      public? true
      description "客户料号"
    end

    attribute :unit_name, :string do
      allow_nil? false
      writable? false
      public? true
      description "单位名称"
    end

    # 过滤锚点:订单/订单条目/公司(纯 uuid 列,不作为 fk 渲染)
    attribute :order_id, :uuid do
      allow_nil? false
      writable? false
      public? true
      description "订单"
    end

    attribute :order_item_id, :uuid do
      allow_nil? false
      writable? false
      public? true
      description "订单条目"
    end

    attribute :company_id, :uuid do
      allow_nil? false
      writable? false
      public? true
      description "公司"
    end
  end
end
