defmodule SynieCore.Repo.Migrations.RenameOrgCompanyPermissionPrefix do
  @moduledoc """
  公司资源从 Org 挪入 Base,权限前缀 org.company -> base.company。

  org 域随之消失,存量 `org.*` 域通配等价降级为 `base.company:*`
  (当时 org 域只有公司一个资源,授权范围不变)。
  (role_id, permission) 有唯一索引,更新前先排掉会撞键的行,剩余的直接删。
  """

  use Ecto.Migration

  def up do
    execute("""
    UPDATE sys_role_permission src
    SET permission = 'base.company:*'
    WHERE permission = 'org.*'
      AND NOT EXISTS (
        SELECT 1 FROM sys_role_permission t
        WHERE t.role_id = src.role_id AND t.permission = 'base.company:*'
      )
    """)

    execute("DELETE FROM sys_role_permission WHERE permission = 'org.*'")

    execute("""
    UPDATE sys_role_permission src
    SET permission = 'base.company' || substr(permission, 12)
    WHERE permission LIKE 'org.company%'
      AND NOT EXISTS (
        SELECT 1 FROM sys_role_permission t
        WHERE t.role_id = src.role_id
          AND t.permission = 'base.company' || substr(src.permission, 12)
      )
    """)

    execute("DELETE FROM sys_role_permission WHERE permission LIKE 'org.company%'")
  end

  def down do
    # 有损回滚:由 org.* 降级而来的 base.company:* 只能还原成 org.company:*
    execute("""
    UPDATE sys_role_permission src
    SET permission = 'org.company' || substr(permission, 13)
    WHERE permission LIKE 'base.company%'
      AND NOT EXISTS (
        SELECT 1 FROM sys_role_permission t
        WHERE t.role_id = src.role_id
          AND t.permission = 'org.company' || substr(src.permission, 13)
      )
    """)

    execute("DELETE FROM sys_role_permission WHERE permission LIKE 'base.company%'")
  end
end
