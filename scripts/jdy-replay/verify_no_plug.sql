-- 找平残留：A(J)-20200101-0004..0008 必须不存在。只读。
-- journal / line / entry / audit 均为 0。W5 后无 0008；W6 后无 0004–0007。
--
-- 行审计 record_label = idx，changes 只有 journal_id（无 voucher_no）。
-- journal 删掉后靠 journal_id 认孤儿：
--   1) 仍在的 plug journal
--   2) 头审计 record_id（record_label / changes.voucher_no.to）
--   3) W6 删前写入的 TEMP replay_plug_journal_ids
-- 同一会话先 \i 再删再 \i，(1) 会把 id 留下。跨会话把 id 拷进该 TEMP。
--
-- psql -v ON_ERROR_STOP=1 -f scripts/jdy-replay/verify_no_plug.sql

CREATE TEMP TABLE IF NOT EXISTS replay_plug_journal_ids (
  id uuid NOT NULL,
  voucher_no text NOT NULL
);

INSERT INTO replay_plug_journal_ids (id, voucher_no)
SELECT j.id, j.voucher_no
FROM acc_gl_journal j
WHERE j.date = DATE '2020-01-01'
  AND j.voucher_no IN (
    'A(J)-20200101-0004',
    'A(J)-20200101-0005',
    'A(J)-20200101-0006',
    'A(J)-20200101-0007',
    'A(J)-20200101-0008'
  )
  AND NOT EXISTS (
    SELECT 1 FROM replay_plug_journal_ids x WHERE x.id = j.id
  );

INSERT INTO replay_plug_journal_ids (id, voucher_no)
SELECT DISTINCT a.record_id,
       COALESCE(
         NULLIF(a.record_label, ''),
         a.changes #>> '{voucher_no,to}'
       )
FROM sys_audit_log a
WHERE a.resource = 'acc_gl_journal'
  AND (
    a.record_label IN (
      'A(J)-20200101-0004',
      'A(J)-20200101-0005',
      'A(J)-20200101-0006',
      'A(J)-20200101-0007',
      'A(J)-20200101-0008'
    )
    OR a.changes #>> '{voucher_no,to}' IN (
      'A(J)-20200101-0004',
      'A(J)-20200101-0005',
      'A(J)-20200101-0006',
      'A(J)-20200101-0007',
      'A(J)-20200101-0008'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM replay_plug_journal_ids x WHERE x.id = a.record_id
  );

\echo '===== verify_no_plug: 0004-0008 journal / entry / line / audit ====='

WITH plug AS (
  SELECT * FROM (VALUES
    ('A(J)-20200101-0004'),
    ('A(J)-20200101-0005'),
    ('A(J)-20200101-0006'),
    ('A(J)-20200101-0007'),
    ('A(J)-20200101-0008')
  ) AS v(voucher_no)
)
SELECT
  p.voucher_no,
  (SELECT count(*) FROM acc_gl_journal j
    WHERE j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01') AS journals,
  (SELECT count(*) FROM acc_gl_entry e
    WHERE e.voucher_no = p.voucher_no) AS entries_by_no,
  (SELECT count(*)
    FROM acc_gl_entry e
    JOIN acc_gl_journal j ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
    WHERE j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01') AS entries_by_journal,
  (SELECT count(*)
    FROM acc_gl_journal_line l
    JOIN acc_gl_journal j ON j.id = l.journal_id
    WHERE j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01') AS lines,
  (SELECT count(*)
    FROM sys_audit_log a
    WHERE a.resource = 'acc_gl_journal'
      AND (a.record_label = p.voucher_no
           OR a.changes #>> '{voucher_no,to}' = p.voucher_no)) AS audit_journal,
  (SELECT count(*)
    FROM sys_audit_log a
    JOIN replay_plug_journal_ids i
      ON i.voucher_no = p.voucher_no
     AND a.changes #>> '{journal_id,to}' = i.id::text
    WHERE a.resource = 'acc_gl_journal_line') AS audit_line
FROM plug p
ORDER BY 1;

\echo '===== 非 0 即失败（应 0 行）====='
WITH plug AS (
  SELECT * FROM (VALUES
    ('A(J)-20200101-0004'),
    ('A(J)-20200101-0005'),
    ('A(J)-20200101-0006'),
    ('A(J)-20200101-0007'),
    ('A(J)-20200101-0008')
  ) AS v(voucher_no)
),
hits AS (
  SELECT p.voucher_no, 'journal'::text AS kind, j.id::text AS id
  FROM plug p
  JOIN acc_gl_journal j ON j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01'
  UNION ALL
  SELECT p.voucher_no, 'entry', e.id::text
  FROM plug p
  JOIN acc_gl_entry e ON e.voucher_no = p.voucher_no
  UNION ALL
  SELECT p.voucher_no, 'line', l.id::text
  FROM plug p
  JOIN acc_gl_journal j ON j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01'
  JOIN acc_gl_journal_line l ON l.journal_id = j.id
  UNION ALL
  SELECT p.voucher_no, 'audit_journal', a.id::text
  FROM plug p
  JOIN sys_audit_log a
    ON a.resource = 'acc_gl_journal'
   AND (a.record_label = p.voucher_no
        OR a.changes #>> '{voucher_no,to}' = p.voucher_no)
  UNION ALL
  SELECT i.voucher_no, 'audit_line', a.id::text
  FROM replay_plug_journal_ids i
  JOIN sys_audit_log a
    ON a.resource = 'acc_gl_journal_line'
   AND a.changes #>> '{journal_id,to}' = i.id::text
)
SELECT * FROM hits;
