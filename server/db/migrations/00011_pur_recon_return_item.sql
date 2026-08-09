-- 采购对账条目纳入采购退货条目：来源改三来源恰一（采购入库/委外入库/采购退货）。
-- 委外退货为纯数量单、不进池（ADR 2026-08-09）。退货行金额取负由应用层 snapshotAmounts 负责。

ALTER TABLE public.pur_reconciliation_item
    ADD COLUMN return_item_id uuid,
    ADD CONSTRAINT pur_reconciliation_item_return_item_id_fkey
        FOREIGN KEY (return_item_id) REFERENCES public.pur_return_item(id),
    DROP CONSTRAINT receipt_item_exactly_one,
    ADD CONSTRAINT receipt_item_exactly_one
        CHECK ((num_nonnulls(receipt_item_id, outsourced_receipt_item_id, return_item_id) = 1));

CREATE INDEX pur_reconciliation_item_return_item_id_index
    ON public.pur_reconciliation_item USING btree (return_item_id);
