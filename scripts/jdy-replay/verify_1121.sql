-- 1121 科目余额 vs acc_bill_holding，按公司。只读。
-- 白名单 2,217.64 单独列。未作废手工凭证 1121 白名单外必须为 0。
-- 1121 不是往来角色，不进应收应付报表——不要拿报表页来对。
--
-- 持有合计应 ≈ 1,227,342.56（31 张）。W4 往 replay_1121_whitelist
-- 插入 2217.64 那张 voucher_no（及点名「票据补记」）。
--
-- psql -v ON_ERROR_STOP=1 -f scripts/jdy-replay/verify_1121.sql

\echo '===== verify_1121: 科目 vs 持有（按公司）。不对 AR/AP 报表 ====='

-- W4 把 voucher_no 换成实号；金额 2217.64 先按金额认
CREATE TEMP TABLE IF NOT EXISTS replay_1121_whitelist (
  voucher_no text,
  amount numeric NOT NULL
);
INSERT INTO replay_1121_whitelist (voucher_no, amount)
SELECT NULL, 2217.64
WHERE NOT EXISTS (SELECT 1 FROM replay_1121_whitelist);

WITH gl AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  WHERE NOT e.is_cancelled
    AND a.code = '1121'
  GROUP BY 1
),
hold AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    ROUND(SUM(h.amount), 2) AS amt
  FROM acc_bill_holding h
  JOIN bas_company co ON co.id = h.company_id
  GROUP BY 1
)
SELECT
  COALESCE(g.company, h.company) AS company,
  COALESCE(g.amt, 0) AS gl_1121,
  COALESCE(h.amt, 0) AS holding,
  COALESCE(g.amt, 0) - COALESCE(h.amt, 0) AS gl_minus_holding
FROM gl g
FULL OUTER JOIN hold h ON h.company = g.company
ORDER BY 1;

\echo '===== 全库合计 vs 1,227,342.56 ====='
SELECT
  (SELECT ROUND(SUM(e.debit - e.credit), 2)
   FROM acc_gl_entry e
   JOIN bas_account a ON a.id = e.account_id
   WHERE NOT e.is_cancelled AND a.code = '1121') AS gl_1121,
  (SELECT ROUND(SUM(amount), 2) FROM acc_bill_holding) AS holding,
  1227342.56::numeric AS expected_holding;

\echo '===== 未作废 journal 1121 白名单外（必须 0 行）====='
SELECT j.voucher_no, e.debit, e.credit, e.company_id
FROM acc_gl_entry e
JOIN acc_gl_journal j ON j.id = e.voucher_id
JOIN bas_account a ON a.id = e.account_id
WHERE e.voucher_type = 'acc.gl_journal'
  AND NOT e.is_cancelled
  AND a.code = '1121'
  AND NOT EXISTS (
    SELECT 1 FROM replay_1121_whitelist w
    WHERE w.voucher_no IS NOT NULL AND w.voucher_no = j.voucher_no
  )
  AND NOT (
    e.credit = 2217.64 AND e.debit = 0
    OR e.debit = 2217.64 AND e.credit = 0
  );

\echo '===== 白名单 2217.64 实数（informational）====='
SELECT j.voucher_no, e.debit, e.credit
FROM acc_gl_entry e
JOIN acc_gl_journal j ON j.id = e.voucher_id
JOIN bas_account a ON a.id = e.account_id
WHERE e.voucher_type = 'acc.gl_journal'
  AND NOT e.is_cancelled
  AND a.code = '1121'
  AND (e.debit = 2217.64 OR e.credit = 2217.64);
