-- 销售对账条目纳入退货条目：双来源恰一（发货条目或销售退货条目），镜像采购侧 receipt_item_exactly_one 先例。
-- 退货行金额取负由应用层 snapshotAmounts 负责；reconciled_qty 投影按来源分表更新。

ALTER TABLE public.sal_reconciliation_item
    ALTER COLUMN delivery_item_id DROP NOT NULL,
    ADD COLUMN return_item_id uuid,
    ADD CONSTRAINT sal_reconciliation_item_return_item_id_fkey
        FOREIGN KEY (return_item_id) REFERENCES public.sal_return_item(id),
    ADD CONSTRAINT sal_recon_item_source_exactly_one
        CHECK ((num_nonnulls(delivery_item_id, return_item_id) = 1));

CREATE INDEX sal_reconciliation_item_return_item_id_index
    ON public.sal_reconciliation_item USING btree (return_item_id);
