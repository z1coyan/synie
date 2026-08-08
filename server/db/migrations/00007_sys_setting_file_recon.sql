-- 文件存储对账（jobs/filesclean）运行摘要落 sys_setting，与行情拉取摘要同款形态。
ALTER TABLE public.sys_setting
    ADD COLUMN file_recon_last_run_at timestamp(0) without time zone,
    ADD COLUMN file_recon_last_summary text;
