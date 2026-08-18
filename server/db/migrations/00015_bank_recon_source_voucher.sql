-- 银行对账挂总账来源单据（ADR 2026-08-18）。
-- 存量行全部来自手工凭证，按 journal_id 回填 voucher_* 后去掉 journal 外键。

ALTER TABLE public.acc_bank_reconciliation
  ADD COLUMN voucher_type text,
  ADD COLUMN voucher_id uuid,
  ADD COLUMN voucher_no text;

UPDATE public.acc_bank_reconciliation r
SET voucher_type = 'acc.gl_journal',
    voucher_id = r.journal_id,
    voucher_no = j.voucher_no
FROM public.acc_gl_journal j
WHERE j.id = r.journal_id;

ALTER TABLE public.acc_bank_reconciliation
  ALTER COLUMN voucher_type SET NOT NULL,
  ALTER COLUMN voucher_id SET NOT NULL,
  ALTER COLUMN voucher_no SET NOT NULL;

ALTER TABLE public.acc_bank_reconciliation
  DROP CONSTRAINT acc_bank_reconciliation_journal_id_fkey;

DROP INDEX public.acc_bank_reconciliation_journal_id_index;
DROP INDEX public.acc_bank_reconciliation_unique_txn_journal_index;

ALTER TABLE public.acc_bank_reconciliation
  DROP COLUMN journal_id;

CREATE INDEX acc_bank_reconciliation_voucher_index
  ON public.acc_bank_reconciliation USING btree (voucher_type, voucher_id);

CREATE UNIQUE INDEX acc_bank_reconciliation_unique_txn_voucher_index
  ON public.acc_bank_reconciliation USING btree (bank_transaction_id, voucher_type, voucher_id);
