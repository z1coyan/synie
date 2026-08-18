-- 今天 1124（拆开，不要拿全库 verify6 直接对混集）。只读。
--
-- 1) 有 remarks LIKE '简道云出库:%' 的头：
--    对手×公司 ROUND(SUM((qty-reconciled_qty)*order_price),2)
--    = 未作废 1124（同源 remarks）；来源仅 sales.delivery。
-- 2) 无该备注的头：1124 发生额 vs W5 前快照 replay_1124_non_jdy_snap 0 超差。
-- 3) 未作废 sales.delivery 分录所在头备注不是该前缀的行数 = 0。
--
-- W5 前落快照（另开会话，本脚本不建）：
--   CREATE TABLE replay_1124_non_jdy_snap AS
--   SELECT e.voucher_id,
--          ROUND(SUM(e.debit - e.credit), 2) AS amt
--   FROM acc_gl_entry e
--   JOIN bas_account a ON a.id = e.account_id
--   JOIN sal_delivery d ON d.id = e.voucher_id
--   WHERE e.voucher_type = 'sales.delivery'
--     AND NOT e.is_cancelled
--     AND a.code = '1124'
--     AND (d.remarks IS NULL OR d.remarks NOT LIKE '简道云出库:%')
--   GROUP BY e.voucher_id;
-- 硬闸为 0 时第 2 条真空为真（快照也应为空）。
--
-- psql -v ON_ERROR_STOP=1 -f scripts/jdy-replay/verify_1124.sql

\echo '===== verify_1124 3) 非 JDY 备注却有未作废 delivery GL（必须 0）====='
SELECT count(*) AS non_jdy_live_delivery_gl
FROM acc_gl_entry e
JOIN sal_delivery d ON d.id = e.voucher_id
WHERE e.voucher_type = 'sales.delivery'
  AND NOT e.is_cancelled
  AND (d.remarks IS NULL OR d.remarks NOT LIKE '简道云出库:%');

\echo '===== verify_1124 1) JDY 备注头：1124 vs remain+remarks（|diff|>0.01 应为 0 行）====='
WITH gl AS (
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
  JOIN sal_delivery d ON d.id = e.voucher_id
  WHERE e.party_type = 'customer'
    AND NOT e.is_cancelled
    AND a.code = '1124'
    AND e.voucher_type = 'sales.delivery'
    AND d.remarks LIKE '简道云出库:%'
  GROUP BY 1, 2
),
rem AS (
  SELECT
    CASE
      WHEN co.code IN ('JT', '京泰') THEN '京泰'
      WHEN co.code IN ('DF', '东方') THEN '东方'
      ELSE co.code
    END AS company,
    c.code AS party_code,
    ROUND(SUM((i.qty - i.reconciled_qty) * i.order_price), 2) AS amt
  FROM sal_delivery_item i
  JOIN sal_delivery d ON d.id = i.delivery_id
  JOIN bas_company co ON co.id = d.company_id
  JOIN sal_customers c ON c.id = d.party_id
  WHERE d.status = 'audited'
    AND d.remarks LIKE '简道云出库:%'
  GROUP BY 1, 2
)
SELECT
  COALESCE(g.party_code, r.party_code) AS party_code,
  COALESCE(g.company, r.company) AS company,
  COALESCE(g.amt, 0) AS gl_1124,
  COALESCE(r.amt, 0) AS remain,
  COALESCE(g.amt, 0) - COALESCE(r.amt, 0) AS diff
FROM gl g
FULL OUTER JOIN rem r
  ON r.party_code = g.party_code AND r.company = g.company
WHERE ABS(COALESCE(g.amt, 0) - COALESCE(r.amt, 0)) > 0.01
ORDER BY ABS(COALESCE(g.amt, 0) - COALESCE(r.amt, 0)) DESC;

\echo '===== verify_1124 1b) 1124 来源不是 sales.delivery 的未作废行（JDY 终态应为 0）====='
SELECT e.voucher_type, count(*) AS n
FROM acc_gl_entry e
JOIN bas_account a ON a.id = e.account_id
WHERE NOT e.is_cancelled
  AND a.code = '1124'
  AND e.voucher_type <> 'sales.delivery'
GROUP BY 1
ORDER BY 1;

\echo '===== verify_1124 2) 非 JDY 头 1124 vs replay_1124_non_jdy_snap ====='
CREATE TEMP TABLE IF NOT EXISTS replay_1124_snap_diff (
  voucher_id uuid,
  snap_amt numeric,
  live_amt numeric,
  diff numeric
);
TRUNCATE replay_1124_snap_diff;
DO $$
BEGIN
  IF to_regclass('replay_1124_non_jdy_snap') IS NULL THEN
    RAISE NOTICE 'skip snap compare: replay_1124_non_jdy_snap 不存在（硬闸为 0 时真空为真）';
    RETURN;
  END IF;
  INSERT INTO replay_1124_snap_diff
  SELECT
    COALESCE(s.voucher_id, live.voucher_id),
    COALESCE(s.amt, 0),
    COALESCE(live.amt, 0),
    COALESCE(live.amt, 0) - COALESCE(s.amt, 0)
  FROM replay_1124_non_jdy_snap s
  FULL OUTER JOIN (
    SELECT e.voucher_id, ROUND(SUM(e.debit - e.credit), 2) AS amt
    FROM acc_gl_entry e
    JOIN bas_account a ON a.id = e.account_id
    JOIN sal_delivery d ON d.id = e.voucher_id
    WHERE e.voucher_type = 'sales.delivery'
      AND NOT e.is_cancelled
      AND a.code = '1124'
      AND (d.remarks IS NULL OR d.remarks NOT LIKE '简道云出库:%')
    GROUP BY e.voucher_id
  ) live ON live.voucher_id = s.voucher_id
  WHERE ABS(COALESCE(live.amt, 0) - COALESCE(s.amt, 0)) > 0.01;
END $$;
SELECT * FROM replay_1124_snap_diff;
