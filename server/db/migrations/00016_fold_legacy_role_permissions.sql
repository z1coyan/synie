-- 存量授权收口（部署时由 bun db/migrate.ts 执行）。
-- 空范围默认 all；有映射则补写新动作行，旧行留给后续退役。
-- 不删除未映射旧码；不跑 seed；不加 acc.ar_ap:read。

UPDATE public.sys_role_permission
SET scope = 'all'
WHERE scope IS NULL;

INSERT INTO public.sys_role_permission (role_id, permission, scope)
SELECT folded.role_id, folded.permission, folded.scope
FROM (
  SELECT DISTINCT ON (
    rp.role_id,
    regexp_replace(rp.permission, ':[^:]+$', ':' || m.new_action)
  )
    rp.role_id,
    regexp_replace(rp.permission, ':[^:]+$', ':' || m.new_action) AS permission,
    COALESCE(rp.scope, 'all') AS scope
  FROM public.sys_role_permission rp
  INNER JOIN public.sys_role r ON r.id = rp.role_id AND NOT r.grants_all
  INNER JOIN (
    VALUES
      ('close', 'audit'),
      ('cancel', 'void'),
      ('approve', 'audit'),
      ('activate', 'update'),
      ('deactivate', 'update'),
      ('setDefault', 'update'),
      ('unsetDefault', 'update'),
      ('batch_update', 'update'),
      ('batch_delete', 'delete'),
      ('batch_print', 'print'),
      ('confirm', 'audit'),
      ('unconfirm', 'update'),
      ('import', 'create'),
      ('reverse', 'create'),
      ('ship', 'audit'),
      ('receive', 'audit'),
      ('dispatch', 'update'),
      ('recalc', 'update'),
      ('reconcile', 'update')
  ) AS m(old_action, new_action)
    ON substring(rp.permission FROM '[^:]+$') = m.old_action
  ORDER BY
    rp.role_id,
    regexp_replace(rp.permission, ':[^:]+$', ':' || m.new_action),
    CASE COALESCE(rp.scope, 'all')
      WHEN 'all' THEN 1
      WHEN 'dept_tree' THEN 2
      WHEN 'dept' THEN 3
      WHEN 'self' THEN 4
      ELSE 5
    END
) AS folded
ON CONFLICT (role_id, permission) DO NOTHING;
