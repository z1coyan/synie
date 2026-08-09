-- 收发货历史视图扩退货三类（ADR 2026-07-25 预留扩展点）：
-- 销售退货/采购退货/委外退货三条 UNION ALL 臂；数量正数展示、类型名自明方向。
-- 退货条目自身带 order_item_id 列（源单行派生写入；手工行为空，不入订单锚点历史——INNER JOIN 自然剔除）。

CREATE OR REPLACE VIEW public.scm_order_flow_item AS
 SELECT ('purchase_receipt:'::text || (i.id)::text) AS id,
    'purchase_receipt'::text AS flow_type,
    h.receipt_no AS voucher_no,
    h.receipt_date AS voucher_date,
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
   FROM ((public.pur_receipt_item i
     JOIN public.pur_receipt h ON ((h.id = i.receipt_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('outsourced_receipt:'::text || (i.id)::text) AS id,
    'outsourced_receipt'::text AS flow_type,
    h.receipt_no AS voucher_no,
    h.receipt_date AS voucher_date,
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
   FROM ((public.pur_outsourced_receipt_item i
     JOIN public.pur_outsourced_receipt h ON ((h.id = i.receipt_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('outsourced_issue:'::text || (i.id)::text) AS id,
    'outsourced_issue'::text AS flow_type,
    h.issue_no AS voucher_no,
    h.issue_date AS voucher_date,
    h.status,
    i.company_id,
    oi.order_id,
    oim.order_item_id,
    i.material_code,
    i.material_name,
    i.material_spec,
    NULL::text AS customer_part_no,
    i.unit_name,
    i.qty
   FROM (((public.pur_outsourced_issue_item i
     JOIN public.pur_outsourced_issue h ON ((h.id = i.issue_id)))
     JOIN public.pur_order_item_material oim ON ((oim.id = i.order_item_material_id)))
     JOIN public.pur_order_item oi ON ((oi.id = oim.order_item_id)))
UNION ALL
 SELECT ('sales_delivery:'::text || (i.id)::text) AS id,
    'sales_delivery'::text AS flow_type,
    h.delivery_no AS voucher_no,
    h.delivery_date AS voucher_date,
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
   FROM ((public.sal_delivery_item i
     JOIN public.sal_delivery h ON ((h.id = i.delivery_id)))
     JOIN public.sal_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('sales_return:'::text || (i.id)::text) AS id,
    'sales_return'::text AS flow_type,
    h.return_no AS voucher_no,
    h.return_date AS voucher_date,
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
   FROM ((public.sal_return_item i
     JOIN public.sal_return h ON ((h.id = i.return_id)))
     JOIN public.sal_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('purchase_return:'::text || (i.id)::text) AS id,
    'purchase_return'::text AS flow_type,
    h.return_no AS voucher_no,
    h.return_date AS voucher_date,
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
   FROM ((public.pur_return_item i
     JOIN public.pur_return h ON ((h.id = i.return_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)))
UNION ALL
 SELECT ('outsourced_return:'::text || (i.id)::text) AS id,
    'outsourced_return'::text AS flow_type,
    h.return_no AS voucher_no,
    h.return_date AS voucher_date,
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
   FROM ((public.pur_outsourced_return_item i
     JOIN public.pur_outsourced_return h ON ((h.id = i.return_id)))
     JOIN public.pur_order_item oi ON ((oi.id = i.order_item_id)));
