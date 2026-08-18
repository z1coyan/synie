-- W6 删 0004–0007 之前的预演恒等式（只读，不删）。
-- 主集逐户逐公司（容差 0.01）：
--   Σ(0004..0007 未作废 1122, 借−贷)
--     == Σ(窗口内 acc.vat_invoice 1122)
--      + Σ(窗口内 新过账接收 1122)          -- 通常为贷
--      + Σ(窗口内 客户退回 ENDORSE 1122)     -- 借
--      + Σ(0001N 七行负数 1122)             -- 贷
--      + known_gaps                         -- 默认 0
--
-- inserted_at 是 timestamp without time zone，存 UTC 墙钟
-- （DEFAULT now() AT TIME ZONE 'utc'）。比较时先 AT TIME ZONE 'UTC'，
-- window_start 必须带时区，中国冻结夜用 +08：
--   psql -v ON_ERROR_STOP=1 -v window_start='2026-08-18 16:00:00+08' \
--        -f scripts/jdy-replay/verify_identity.sql
-- 对不上：停，不删找平。
--
-- known_gaps：把下面 VALUES 里 '__none__' 行换成逐项清单
-- （未导 29 张里 v3 有而 synie 无票、538 无档、对不上的票据补记等）。
-- 主集 gap 合计必须为 0 才许 W6。

\if :{?window_start}
\else
\set window_start '2099-01-01 00:00:00+08'
\endif

\echo '===== verify_identity: 0004-0007 1122 vs 新过账 1122 ====='
\echo 'window_start=' :window_start
\echo '未传 -v window_start 时默认 2099-01-01+08，新过账侧为空，仅用于看找平贡献。'
\echo 'window_start 须带时区（中国 16:00 → 2026-08-18 16:00:00+08）。'

WITH plug AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  JOIN sal_customers c ON c.id = e.party_id
  JOIN acc_gl_journal j
    ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND j.date = DATE '2020-01-01'
    AND j.voucher_no IN (
      'A(J)-20200101-0004',
      'A(J)-20200101-0005',
      'A(J)-20200101-0006',
      'A(J)-20200101-0007'
    )
  GROUP BY 1, 2
),
inv AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  JOIN sal_customers c ON c.id = e.party_id
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND e.voucher_type = 'acc.vat_invoice'
    AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
  GROUP BY 1, 2
),
new_recv AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  JOIN sal_customers c ON c.id = e.party_id
  JOIN acc_bill_transaction t ON t.id = e.voucher_id
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND e.voucher_type = 'acc.bill_transaction'
    AND upper(t.transaction_type) = 'RECEIVE'
    AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
  GROUP BY 1, 2
),
ret AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  JOIN sal_customers c ON c.id = e.party_id
  JOIN acc_bill_transaction t ON t.id = e.voucher_id
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND e.voucher_type = 'acc.bill_transaction'
    AND upper(t.transaction_type) = 'ENDORSE'
    AND lower(t.party_type) = 'customer'
    AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
  GROUP BY 1, 2
),
n1 AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM(e.debit - e.credit), 2) AS amt
  FROM acc_gl_entry e
  JOIN bas_account a ON a.id = e.account_id
  JOIN bas_company co ON co.id = e.company_id
  JOIN sal_customers c ON c.id = e.party_id
  JOIN acc_gl_journal j
    ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND j.voucher_no = 'A(J)-20200101-0001N'
    AND j.date = DATE '2020-01-01'
  GROUP BY 1, 2
),
known_gaps AS (
  SELECT party_code, company, amount
  FROM (VALUES
    ('__none__'::text, '京泰'::text, 0::numeric)
  ) AS g(party_code, company, amount)
  WHERE party_code IS DISTINCT FROM '__none__'
),
posted AS (
  SELECT company, party_code, SUM(amt) AS amt
  FROM (
    SELECT * FROM inv
    UNION ALL SELECT * FROM new_recv
    UNION ALL SELECT * FROM ret
    UNION ALL SELECT * FROM n1
    UNION ALL SELECT company, party_code, amount FROM known_gaps
  ) u
  GROUP BY 1, 2
)
SELECT
  COALESCE(p.party_code, n.party_code) AS party_code,
  COALESCE(p.company, n.company) AS company,
  COALESCE(p.amt, 0) AS plug_0004_0007,
  COALESCE(n.amt, 0) AS newly_posted,
  COALESCE(p.amt, 0) - COALESCE(n.amt, 0) AS diff
FROM plug p
FULL OUTER JOIN posted n
  ON n.party_code = p.party_code AND n.company = p.company
WHERE ABS(COALESCE(p.amt, 0) - COALESCE(n.amt, 0)) > 0.01
ORDER BY ABS(COALESCE(p.amt, 0) - COALESCE(n.amt, 0)) DESC,
         party_code, company;

\echo '===== 分量合计（informational）====='
SELECT '0004-0007' AS kind, ROUND(SUM(e.debit - e.credit), 2) AS amt
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
JOIN acc_gl_journal j
  ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
WHERE NOT e.is_cancelled AND a.code = '1122'
  AND j.date = DATE '2020-01-01'
  AND j.voucher_no IN (
    'A(J)-20200101-0004', 'A(J)-20200101-0005',
    'A(J)-20200101-0006', 'A(J)-20200101-0007'
  )
UNION ALL
SELECT 'acc.vat_invoice', ROUND(SUM(e.debit - e.credit), 2)
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
WHERE NOT e.is_cancelled AND a.code = '1122'
  AND e.voucher_type = 'acc.vat_invoice'
  AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
UNION ALL
SELECT 'new RECEIVE', ROUND(SUM(e.debit - e.credit), 2)
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
JOIN acc_bill_transaction t ON t.id = e.voucher_id
WHERE NOT e.is_cancelled AND a.code = '1122'
  AND e.voucher_type = 'acc.bill_transaction'
  AND upper(t.transaction_type) = 'RECEIVE'
  AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
UNION ALL
SELECT 'customer ENDORSE', ROUND(SUM(e.debit - e.credit), 2)
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
JOIN acc_bill_transaction t ON t.id = e.voucher_id
WHERE NOT e.is_cancelled AND a.code = '1122'
  AND e.voucher_type = 'acc.bill_transaction'
  AND upper(t.transaction_type) = 'ENDORSE'
  AND lower(t.party_type) = 'customer'
  AND (e.inserted_at AT TIME ZONE 'UTC') >= :'window_start'::timestamptz
UNION ALL
SELECT '0001N', ROUND(SUM(e.debit - e.credit), 2)
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
JOIN acc_gl_journal j
  ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
WHERE NOT e.is_cancelled AND a.code = '1122'
  AND j.voucher_no = 'A(J)-20200101-0001N';
