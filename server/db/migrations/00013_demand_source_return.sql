-- 履约需求单来源退货留痕：销售退货单「生成补货需求单」派生的需求单头记录来源退货单。
ALTER TABLE public.mfg_demand
    ADD COLUMN source_return_id uuid,
    ADD CONSTRAINT mfg_demand_source_return_id_fkey
        FOREIGN KEY (source_return_id) REFERENCES public.sal_return(id);

COMMENT ON COLUMN public.mfg_demand.source_return_id IS '退货补货来源留痕（销售退货单「生成补货需求单」派生写入；可重复生成，每次一张新草稿）';

CREATE INDEX mfg_demand_source_return_id_index ON public.mfg_demand USING btree (source_return_id);
