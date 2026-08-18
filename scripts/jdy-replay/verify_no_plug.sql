-- 找平残留：A(J)-20200101-0004..0008 必须不存在。只读。
-- journal / line / entry / audit 均为 0。W5 后无 0008；W6 后无 0004–0007。
--
-- psql -v ON_ERROR_STOP=1 -f scripts/jdy-replay/verify_no_plug.sql

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
    JOIN acc_gl_journal j ON j.id = a.record_id
    WHERE a.resource = 'acc_gl_journal'
      AND j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01') AS audit_journal,
  (SELECT count(*)
    FROM sys_audit_log a
    JOIN acc_gl_journal_line l ON l.id = a.record_id
    JOIN acc_gl_journal j ON j.id = l.journal_id
    WHERE a.resource = 'acc_gl_journal_line'
      AND j.voucher_no = p.voucher_no AND j.date = DATE '2020-01-01') AS audit_line
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
)
SELECT * FROM hits;
