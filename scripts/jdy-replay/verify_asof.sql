-- 截日 1122（posting_date<=T）vs formula_asof.py 输出。只读。
-- 主集 |diff|>0.01 应为 0 行。
--
-- 主集 = 仪表盘户，排除 8038 / 538 / v2_carry 80xx
--   （8044/8046/8047/8052/8053/8059/8062/8065/8081/8084/8086）。
-- formula_asof 不含这些留档户；FULL OUTER 若不排除，8038 等会永远非 0 行。
--
-- 用法（必须按序）：
--   python3 scripts/jdy-replay/formula_asof.py --as-of 2023-12-31 -o /tmp/formula_asof.csv
--   psql -v ON_ERROR_STOP=1 -v as_of=2023-12-31
--   \i scripts/jdy-replay/verify_asof.sql            -- 建空表；空表时跳过比对
--   \copy replay_formula_asof (company, party_code, amount) FROM '/tmp/formula_asof.csv' CSV HEADER
--   \i scripts/jdy-replay/verify_asof.sql            -- 有行才比对
--
-- 三个历史日：2023-12-31、2024-12-31、2025-12-31。

\if :{?as_of}
\else
\set as_of `date +%F`
\endif

CREATE TEMP TABLE IF NOT EXISTS replay_formula_asof (
  company text NOT NULL,
  party_code text NOT NULL,
  amount numeric NOT NULL
);

SELECT CASE
         WHEN count(*) = 0
           THEN 'WARNING: replay_formula_asof 为空，已跳过比对（先 \\copy 再 \\i）'
         ELSE 'formula_asof=' || count(*)::text
       END AS replay_formula_asof_status
FROM replay_formula_asof;

\echo '===== verify_asof: posting_date<=' :as_of '1122 vs formula_asof 主集 ====='

WITH exceptions(party_code) AS (
  VALUES
    ('8038'),
    ('538'),
    ('8044'), ('8046'), ('8047'), ('8052'), ('8053'),
    ('8059'), ('8062'), ('8065'), ('8081'), ('8084'), ('8086')
),
tgt AS (
  SELECT
    CASE
      WHEN t.company IN ('京泰', 'JT') THEN '京泰'
      WHEN t.company IN ('东方', 'DF') THEN '东方'
      ELSE t.company
    END AS company,
    t.party_code,
    t.amount
  FROM replay_formula_asof t
),
live AS (
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
    AND e.posting_date <= :'as_of'::date
  GROUP BY 1, 2
)
SELECT
  COALESCE(t.party_code, l.party_code) AS party_code,
  COALESCE(t.company, l.company) AS company,
  COALESCE(l.amt, 0) AS gl_1122,
  COALESCE(t.amount, 0) AS formula_asof,
  COALESCE(l.amt, 0) - COALESCE(t.amount, 0) AS diff
FROM tgt t
FULL OUTER JOIN live l
  ON l.party_code = t.party_code AND l.company = t.company
WHERE (SELECT count(*) FROM replay_formula_asof) > 0
  AND t.party_code IS NOT NULL
  AND t.party_code NOT IN (SELECT party_code FROM exceptions)
  AND ABS(COALESCE(l.amt, 0) - COALESCE(t.amount, 0)) > 0.01
ORDER BY ABS(COALESCE(l.amt, 0) - COALESCE(t.amount, 0)) DESC,
         party_code, company;
