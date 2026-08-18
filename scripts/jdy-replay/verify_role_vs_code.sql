-- 同一 asOf：往来角色 receivable 轧差 − 科目 1122 = 0。
-- 防止某公司 1122 不是唯一 receivable 叶子。只读。不对报表页其它角色。
--
-- psql -v ON_ERROR_STOP=1 -v as_of=2026-08-17 -f scripts/jdy-replay/verify_role_vs_code.sql
-- 不传 as_of 则 CURRENT_DATE。

\if :{?as_of}
\else
\set as_of `date +%F`
\endif

\echo '===== verify_role_vs_code: receivable − 1122（|diff|>0.01 应为 0 行）====='

WITH bounds AS (
  SELECT :'as_of'::date AS as_of
),
role_net AS (
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
  CROSS JOIN bounds b
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.role = 'receivable'
    AND e.posting_date <= b.as_of
  GROUP BY 1, 2
),
code_net AS (
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
  CROSS JOIN bounds b
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1122'
    AND e.posting_date <= b.as_of
  GROUP BY 1, 2
)
SELECT
  COALESCE(r.party_code, c.party_code) AS party_code,
  COALESCE(r.company, c.company) AS company,
  COALESCE(r.amt, 0) AS receivable_role,
  COALESCE(c.amt, 0) AS code_1122,
  COALESCE(r.amt, 0) - COALESCE(c.amt, 0) AS diff
FROM role_net r
FULL OUTER JOIN code_net c
  ON c.party_code = r.party_code AND c.company = r.company
WHERE ABS(COALESCE(r.amt, 0) - COALESCE(c.amt, 0)) > 0.01
ORDER BY ABS(COALESCE(r.amt, 0) - COALESCE(c.amt, 0)) DESC,
         party_code, company;
