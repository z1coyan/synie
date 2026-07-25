defmodule SynieCore.Repo.Migrations.CreateScmOrderFlowItem do
  @moduledoc """
  订单收发货历史只读视图(ADR 2026-07-25):UNION ALL 采购入库、委外发料、委外入库、
  销售发货四类单据行,统一列口径(类型/单号/日期/状态/物料快照/单位/数量),
  供销售/采购订单抽屉「收发货历史」tab 单表查询;未来退货等单据类型只需扩展本视图。
  委外发料行经发料清单行(pur_order_item_material)桥接取订单与订单条目。
  """

  use Ecto.Migration

  def up do
    execute("""
    CREATE VIEW scm_order_flow_item AS
    SELECT
      'purchase_receipt:' || i.id::text AS id,
      'purchase_receipt'::text AS flow_type,
      h.receipt_no AS voucher_no,
      h.receipt_date AS voucher_date,
      h.status AS status,
      i.company_id AS company_id,
      oi.order_id AS order_id,
      i.order_item_id AS order_item_id,
      i.material_code AS material_code,
      i.material_name AS material_name,
      i.material_spec AS material_spec,
      i.customer_part_no AS customer_part_no,
      i.unit_name AS unit_name,
      i.qty AS qty
    FROM pur_receipt_item i
    JOIN pur_receipt h ON h.id = i.receipt_id
    JOIN pur_order_item oi ON oi.id = i.order_item_id
    UNION ALL
    SELECT
      'outsourced_receipt:' || i.id::text,
      'outsourced_receipt',
      h.receipt_no,
      h.receipt_date,
      h.status,
      i.company_id,
      oi.order_id,
      i.order_item_id,
      i.material_code,
      i.material_name,
      i.material_spec,
      i.customer_part_no,
      i.unit_name,
      i.qty
    FROM pur_outsourced_receipt_item i
    JOIN pur_outsourced_receipt h ON h.id = i.receipt_id
    JOIN pur_order_item oi ON oi.id = i.order_item_id
    UNION ALL
    SELECT
      'outsourced_issue:' || i.id::text,
      'outsourced_issue',
      h.issue_no,
      h.issue_date,
      h.status,
      i.company_id,
      oi.order_id,
      oim.order_item_id,
      i.material_code,
      i.material_name,
      i.material_spec,
      NULL::text,
      i.unit_name,
      i.qty
    FROM pur_outsourced_issue_item i
    JOIN pur_outsourced_issue h ON h.id = i.issue_id
    JOIN pur_order_item_material oim ON oim.id = i.order_item_material_id
    JOIN pur_order_item oi ON oi.id = oim.order_item_id
    UNION ALL
    SELECT
      'sales_delivery:' || i.id::text,
      'sales_delivery',
      h.delivery_no,
      h.delivery_date,
      h.status,
      i.company_id,
      oi.order_id,
      i.order_item_id,
      i.material_code,
      i.material_name,
      i.material_spec,
      i.customer_part_no,
      i.unit_name,
      i.qty
    FROM sal_delivery_item i
    JOIN sal_delivery h ON h.id = i.delivery_id
    JOIN sal_order_item oi ON oi.id = i.order_item_id
    """)
  end

  def down do
    execute("DROP VIEW scm_order_flow_item")
  end
end
