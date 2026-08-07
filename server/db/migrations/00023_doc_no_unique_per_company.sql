-- +goose Up
-- 公司级单据单号唯一性对齐「按公司计数」编号设计：计数器按 {公司编码}|{渲染前缀} 分桶，
-- 渲染出的单号不含公司码，全局唯一索引会让两公司同日开同种单必撞 23505
-- （手填时代靠人工换号规避；编号全面系统生成化后必须根治）。
-- 唯一索引一律放宽为 (company_id, 单号)，对齐 acc_* 四表既有先例；索引名保持不变，
-- service 层 23505 → 「单号已存在」的 constraint 映射不受影响。
-- 全局主数据（物料/员工/工序/工艺模板/BOM）规则本就不按公司计数，其全局唯一索引不动。
-- ADR: docs/系统架构/adr/2026-08-06-system-generated-numbering.md

DROP INDEX public.inv_stock_doc_unique_doc_no_index;
CREATE UNIQUE INDEX inv_stock_doc_unique_doc_no_index ON public.inv_stock_doc USING btree (company_id, doc_no);

DROP INDEX public.inv_stock_transfer_unique_doc_no_index;
CREATE UNIQUE INDEX inv_stock_transfer_unique_doc_no_index ON public.inv_stock_transfer USING btree (company_id, doc_no);

DROP INDEX public.inv_stock_count_unique_doc_no_index;
CREATE UNIQUE INDEX inv_stock_count_unique_doc_no_index ON public.inv_stock_count USING btree (company_id, doc_no);

DROP INDEX public.mfg_demand_unique_demand_no_index;
CREATE UNIQUE INDEX mfg_demand_unique_demand_no_index ON public.mfg_demand USING btree (company_id, demand_no);

DROP INDEX public.mfg_output_unique_output_no_index;
CREATE UNIQUE INDEX mfg_output_unique_output_no_index ON public.mfg_output USING btree (company_id, output_no);

DROP INDEX public.mfg_work_order_unique_work_order_no_index;
CREATE UNIQUE INDEX mfg_work_order_unique_work_order_no_index ON public.mfg_work_order USING btree (company_id, work_order_no);

DROP INDEX public.pur_order_unique_order_no_index;
CREATE UNIQUE INDEX pur_order_unique_order_no_index ON public.pur_order USING btree (company_id, order_no);

DROP INDEX public.pur_outsourced_issue_unique_issue_no_index;
CREATE UNIQUE INDEX pur_outsourced_issue_unique_issue_no_index ON public.pur_outsourced_issue USING btree (company_id, issue_no);

DROP INDEX public.pur_outsourced_receipt_unique_receipt_no_index;
CREATE UNIQUE INDEX pur_outsourced_receipt_unique_receipt_no_index ON public.pur_outsourced_receipt USING btree (company_id, receipt_no);

DROP INDEX public.pur_quotation_unique_quotation_no_index;
CREATE UNIQUE INDEX pur_quotation_unique_quotation_no_index ON public.pur_quotation USING btree (company_id, quotation_no);

DROP INDEX public.pur_receipt_unique_receipt_no_index;
CREATE UNIQUE INDEX pur_receipt_unique_receipt_no_index ON public.pur_receipt USING btree (company_id, receipt_no);

DROP INDEX public.pur_reconciliation_unique_reconciliation_no_index;
CREATE UNIQUE INDEX pur_reconciliation_unique_reconciliation_no_index ON public.pur_reconciliation USING btree (company_id, reconciliation_no);

DROP INDEX public.sal_delivery_unique_delivery_no_index;
CREATE UNIQUE INDEX sal_delivery_unique_delivery_no_index ON public.sal_delivery USING btree (company_id, delivery_no);

DROP INDEX public.sal_order_unique_order_no_index;
CREATE UNIQUE INDEX sal_order_unique_order_no_index ON public.sal_order USING btree (company_id, order_no);

DROP INDEX public.sal_quotation_unique_quotation_no_index;
CREATE UNIQUE INDEX sal_quotation_unique_quotation_no_index ON public.sal_quotation USING btree (company_id, quotation_no);

DROP INDEX public.sal_reconciliation_unique_reconciliation_no_index;
CREATE UNIQUE INDEX sal_reconciliation_unique_reconciliation_no_index ON public.sal_reconciliation USING btree (company_id, reconciliation_no);
