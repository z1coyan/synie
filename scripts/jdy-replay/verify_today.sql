-- W6 之后、今天：1122 科目（code='1122'）逐户逐公司 vs 目标表。
-- 只读。主集 |diff|>0.01 应为 0 行。
--
-- 主集 = 仪表盘户（jdy_targets_v3 source=dashboard），排除：
--   8038 鲸耀、538 锦州森源、v2_carry 80xx
--   （8044/8046/8047/8052/8053/8059/8062/8065/8081/8084/8086）
-- FULL OUTER 仍会看到这些户的 live/公式行，WHERE 排除后闸才能机械判绿。
--
-- 目标表列：company (京泰/东方 或 JT/DF), party_code, amount
-- 用法（必须按序）：
--   psql -v ON_ERROR_STOP=1
--   \i scripts/jdy-replay/verify_today.sql          -- 建空表；空表时跳过比对
--   \copy replay_targets (company, party_code, amount) FROM 'formula_asof.csv' CSV HEADER
--   \i scripts/jdy-replay/verify_today.sql          -- 有行才比对
--
--   -- 或 stdin：
--   \copy replay_targets (company, party_code, amount) FROM STDIN CSV HEADER
--   京泰,58,489921.69
--   \.
--
--   -- 宽表 jdy_targets_v3.csv（code,jt,df）先展开再比（不要含例外户）：
--   -- INSERT INTO replay_targets (company, party_code, amount)
--   --   SELECT '京泰', code, jt FROM ... UNION ALL SELECT '东方', code, df FROM ...;

CREATE TEMP TABLE IF NOT EXISTS replay_targets (
  company text NOT NULL,
  party_code text NOT NULL,
  amount numeric NOT NULL
);

SELECT CASE
         WHEN count(*) = 0
           THEN 'WARNING: replay_targets 为空，已跳过比对（先 \\copy 再 \\i）'
         ELSE 'targets=' || count(*)::text
       END AS replay_targets_status
FROM replay_targets;

\echo '===== verify_today: 1122 code vs replay_targets 主集（|diff|>0.01 应为 0 行）====='

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
  FROM replay_targets t
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
    AND e.posting_date <= CURRENT_DATE
  GROUP BY 1, 2
)
SELECT
  COALESCE(t.party_code, l.party_code) AS party_code,
  COALESCE(t.company, l.company) AS company,
  COALESCE(l.amt, 0) AS gl_1122,
  COALESCE(t.amount, 0) AS target,
  COALESCE(l.amt, 0) - COALESCE(t.amount, 0) AS diff
FROM tgt t
FULL OUTER JOIN live l
  ON l.party_code = t.party_code AND l.company = t.company
WHERE (SELECT count(*) FROM replay_targets) > 0
  AND t.party_code IS NOT NULL
  AND t.party_code NOT IN (SELECT party_code FROM exceptions)
  AND ABS(COALESCE(l.amt, 0) - COALESCE(t.amount, 0)) > 0.01
ORDER BY ABS(COALESCE(l.amt, 0) - COALESCE(t.amount, 0)) DESC,
         party_code, company;
