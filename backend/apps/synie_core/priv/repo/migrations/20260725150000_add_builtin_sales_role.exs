defmodule SynieCore.Repo.Migrations.AddBuiltinSalesRole do
  @moduledoc """
  内置销售业务员角色（builtin）迁移种子：

  - 角色行 + 逐码授权（具体码，非通配），新老环境一致；
  - 幂等，已有则跳过；种子走 SQL 直插，不触发 Ash 层的内置角色守卫；
  - 权限码集合由代码派生，与 Registry.catalog 对齐，新增权限点不自动授予（fail-closed）。
  """

  use Ecto.Migration

  @role_code "sales"
  @role_name "销售业务员"

  # 权限码清单：与权限目录（Registry.catalog）对齐
  @permissions [
    # 销售订单：完整权限
    "sales.order:create",
    "sales.order:read",
    "sales.order:update",
    "sales.order:delete",
    "sales.order:audit",
    "sales.order:close",
    "sales.order:void",
    "sales.order:print",
    "sales.order:export",
    "sales.order:batch_print",
    # 销售发货单：完整权限
    "sales.delivery:create",
    "sales.delivery:read",
    "sales.delivery:update",
    "sales.delivery:delete",
    "sales.delivery:audit",
    "sales.delivery:void",
    "sales.delivery:print",
    "sales.delivery:export",
    "sales.delivery:batch_print",
    # 销售对账单：完整权限
    "sales.reconciliation:create",
    "sales.reconciliation:read",
    "sales.reconciliation:update",
    "sales.reconciliation:delete",
    "sales.reconciliation:confirm",
    "sales.reconciliation:unconfirm",
    "sales.reconciliation:audit",
    "sales.reconciliation:void",
    # 销售报价单：完整权限
    "sales.quotation:create",
    "sales.quotation:read",
    "sales.quotation:update",
    "sales.quotation:delete",
    "sales.quotation:audit",
    "sales.quotation:void",
    # 客户：完整权限
    "sales.customer:create",
    "sales.customer:read",
    "sales.customer:update",
    "sales.customer:delete",
    # 履约需求单：完整权限
    "mfg.demand:create",
    "mfg.demand:read",
    "mfg.demand:update",
    "mfg.demand:delete",
    "mfg.demand:confirm",
    "mfg.demand:close",
    "mfg.demand:void",
    # 物料：只读
    "inv.material:read",
    # 库存分录：只读（库存余额视图复用同一码）
    "inv.stock_entry:read",
    # 仓库：只读
    "inv.warehouse:read",
    # 会计科目：只读
    "base.account:read",
    # 币种：只读
    "base.currency:read",
    # 计量单位：只读
    "base.unit:read"
  ]

  def up do
    # 内置角色行（幂等）
    execute("""
    INSERT INTO sys_role (id, code, name, enabled, builtin, inserted_at, updated_at)
    SELECT gen_random_uuid(), '#{@role_code}', '#{@role_name}', true, true, now(), now()
    WHERE NOT EXISTS (SELECT 1 FROM sys_role WHERE code = '#{@role_code}')
    """)

    # 逐码授权（幂等）
    for permission <- @permissions do
      execute("""
      INSERT INTO sys_role_permission (id, role_id, permission, inserted_at)
      SELECT gen_random_uuid(), r.id, '#{permission}', now()
      FROM sys_role r
      WHERE r.code = '#{@role_code}' AND r.builtin
        AND NOT EXISTS (
          SELECT 1 FROM sys_role_permission rp WHERE rp.role_id = r.id AND rp.permission = '#{permission}'
        )
      """)
    end
  end

  def down do
    # 授权行随角色级联删除（sys_role_permission 有外键级联）
    execute("""
    DELETE FROM sys_role WHERE code = '#{@role_code}' AND builtin
    """)
  end
end
