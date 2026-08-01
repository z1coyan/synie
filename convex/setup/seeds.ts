import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { normalizeCurrency, normalizeUnit } from '../resources/model'

export const COMMON_CURRENCIES = Object.freeze([
  { name: '人民币', isoCode: 'CNY', symbol: '￥' },
  { name: '美元', isoCode: 'USD', symbol: '$' },
  { name: '欧元', isoCode: 'EUR', symbol: '€' },
  { name: '日元', isoCode: 'JPY', symbol: '¥' },
  { name: '港币', isoCode: 'HKD', symbol: 'HK$' },
  { name: '新台币', isoCode: 'TWD', symbol: 'NT$' },
  { name: '英镑', isoCode: 'GBP', symbol: '£' },
  { name: '韩元', isoCode: 'KRW', symbol: '₩' },
  { name: '新加坡元', isoCode: 'SGD', symbol: 'S$' },
  { name: '澳大利亚元', isoCode: 'AUD', symbol: 'A$' },
  { name: '加拿大元', isoCode: 'CAD', symbol: 'C$' },
  { name: '瑞士法郎', isoCode: 'CHF', symbol: 'CHF' },
  { name: '澳门元', isoCode: 'MOP', symbol: 'MOP$' },
  { name: '泰铢', isoCode: 'THB', symbol: '฿' },
  { name: '马来西亚林吉特', isoCode: 'MYR', symbol: 'RM' },
  { name: '印尼盾', isoCode: 'IDR', symbol: 'Rp' },
  { name: '越南盾', isoCode: 'VND', symbol: '₫' },
  { name: '菲律宾比索', isoCode: 'PHP', symbol: '₱' },
  { name: '印度卢比', isoCode: 'INR', symbol: '₹' },
  { name: '俄罗斯卢布', isoCode: 'RUB', symbol: '₽' },
] as const)

const UNIT_SEEDS = Object.freeze([
  ['LENGTH', true, '毫米', 'mm', '1'],
  ['LENGTH', false, '微米', 'μm', '0.001'],
  ['LENGTH', false, '厘米', 'cm', '10'],
  ['LENGTH', false, '米', 'm', '1000'],
  ['LENGTH', false, '英寸', 'in', '25.4'],
  ['AREA', true, '平方毫米', 'mm²', '1'],
  ['AREA', false, '平方厘米', 'cm²', '100'],
  ['AREA', false, '平方米', 'm²', '1000000'],
  ['WEIGHT', false, '克', 'g', '0.000001'],
  ['QUANTITY', true, '件', 'pcs', '1'],
  ['QUANTITY', false, '只', '只', '1'],
  ['QUANTITY', false, '个', '个', '1'],
  ['QUANTITY', false, '套', '套', '1'],
  ['QUANTITY', false, '台', '台', '1'],
  ['QUANTITY', false, '片', '片', '1'],
  ['QUANTITY', false, '根', '根', '1'],
  ['QUANTITY', false, '支', '支', '1'],
  ['QUANTITY', false, '块', '块', '1'],
  ['QUANTITY', false, '张', '张', '1'],
  ['QUANTITY', false, '箱', '箱', '1'],
  ['QUANTITY', false, '包', '包', '1'],
  ['QUANTITY', false, '卷', '卷', '1'],
  ['QUANTITY', false, '捆', '捆', '1'],
  ['QUANTITY', false, '打', '打', '12'],
  ['QUANTITY', false, '次', '次', '1'],
  ['QUANTITY', false, '项', '项', '1'],
] as const)

const CATEGORY_SEEDS = Object.freeze([
  ['F', '产品', [['F(P)', '客户产品成品'], ['F(S)', '半成品'], ['F(G)', '通用成品']]],
  ['P', '包材', [['P(W)', '木箱'], ['P(C)', '纸箱'], ['P(B)', '袋与填充']]],
  ['E', '设备工量具', [['E(E)', '设备'], ['E(T)', '工量具']]],
  ['M', '劳保耗材', [['M(L)', '劳保用品'], ['M(C)', '耗材']]],
  ['S', '服务', [['S(G)', '一般服务']]],
] as const)

export const SALES_ROLE_PERMISSIONS = Object.freeze([
  'sales.order:create', 'sales.order:read', 'sales.order:update', 'sales.order:delete',
  'sales.order:audit', 'sales.order:close', 'sales.order:void', 'sales.order:print',
  'sales.order:export', 'sales.order:batch_print',
  'sales.delivery:create', 'sales.delivery:read', 'sales.delivery:update', 'sales.delivery:delete',
  'sales.delivery:audit', 'sales.delivery:void', 'sales.delivery:print', 'sales.delivery:export',
  'sales.delivery:batch_print',
  'sales.reconciliation:create', 'sales.reconciliation:read', 'sales.reconciliation:update',
  'sales.reconciliation:delete', 'sales.reconciliation:confirm', 'sales.reconciliation:unconfirm',
  'sales.reconciliation:audit', 'sales.reconciliation:void',
  'sales.quotation:create', 'sales.quotation:read', 'sales.quotation:update',
  'sales.quotation:delete', 'sales.quotation:audit', 'sales.quotation:void',
  'sales.customer:create', 'sales.customer:read', 'sales.customer:update', 'sales.customer:delete',
  'mfg.demand:create', 'mfg.demand:read', 'mfg.demand:update', 'mfg.demand:delete',
  'mfg.demand:confirm', 'mfg.demand:close', 'mfg.demand:void',
  'inv.material:read', 'inv.stock_entry:read', 'inv.warehouse:read',
  'base.account:read', 'base.currency:read', 'base.unit:read',
] as const)

export async function seedCommonCurrencies(ctx: Pick<MutationCtx, 'db'>): Promise<number> {
  let created = 0
  for (const item of COMMON_CURRENCIES) {
    const normalized = normalizeCurrency(item)
    const existing = await ctx.db.query('currencies').withIndex('by_iso_code_key', (query) =>
      query.eq('isoCodeKey', normalized.isoCodeKey),
    ).unique()
    if (existing) continue
    const now = Date.now()
    await ctx.db.insert('currencies', { ...normalized, active: false, insertedAt: now, updatedAt: now })
    created += 1
  }
  return created
}

export async function activateSetupCurrency(
  ctx: Pick<MutationCtx, 'db'>,
  currencyId: Id<'currencies'>,
): Promise<void> {
  const selected = await ctx.db.get(currencyId)
  if (!selected) throw new Error('初始化本币不存在')
  for (const currency of await ctx.db.query('currencies').collect()) {
    const active = currency._id === selected._id
    if (currency.active !== active) await ctx.db.patch(currency._id, { active, updatedAt: Date.now() })
  }
}

export async function seedSetupUnits(ctx: Pick<MutationCtx, 'db'>): Promise<number> {
  let created = 0
  for (const [unitType, wantBase, name, symbol, ratio] of UNIT_SEEDS) {
    const normalized = normalizeUnit({ unitType, isBase: wantBase, name, symbol, ratio })
    const existing = await ctx.db.query('units').withIndex('by_symbol_key', (query) =>
      query.eq('symbolKey', normalized.symbolKey),
    ).unique()
    if (existing) continue
    const base = wantBase
      ? await ctx.db.query('units').withIndex('by_type_base', (query) =>
          query.eq('unitType', normalized.unitType).eq('isBase', true),
        ).unique()
      : null
    const now = Date.now()
    await ctx.db.insert('units', {
      ...normalized,
      isBase: wantBase && !base,
      insertedAt: now,
      updatedAt: now,
    })
    created += 1
  }
  return created
}

export async function seedMaterialCategories(ctx: Pick<MutationCtx, 'db'>): Promise<number> {
  if (await ctx.db.query('materialCategories').first()) return 0
  let created = 0
  for (const [code, name, children] of CATEGORY_SEEDS) {
    const now = Date.now()
    const parentId = await ctx.db.insert('materialCategories', {
      code,
      codeKey: code.toLocaleLowerCase(),
      name,
      isLeaf: false,
      active: true,
      parentId: null,
      searchText: `${code} ${name}`.toLocaleLowerCase(),
      insertedAt: now,
      updatedAt: now,
    })
    created += 1
    for (const [childCode, childName] of children) {
      await ctx.db.insert('materialCategories', {
        code: childCode,
        codeKey: childCode.toLocaleLowerCase(),
        name: childName,
        isLeaf: true,
        active: true,
        parentId,
        searchText: `${childCode} ${childName}`.toLocaleLowerCase(),
        insertedAt: now,
        updatedAt: now,
      })
      created += 1
    }
  }
  return created
}

async function ensureBuiltinRole(
  ctx: Pick<MutationCtx, 'db'>,
  code: string,
  name: string,
  permissions: readonly string[],
): Promise<number> {
  let role = await ctx.db.query('iamRoles').withIndex('by_code', (query) => query.eq('code', code)).unique()
  if (role && !role.builtin) return 0
  if (!role) {
    const now = Date.now()
    const id = await ctx.db.insert('iamRoles', {
      code,
      name,
      enabled: true,
      builtin: true,
      insertedAt: now,
      updatedAt: now,
    })
    role = (await ctx.db.get(id))!
  }
  const existing = new Set(
    (await ctx.db.query('iamRolePermissions').withIndex('by_role', (query) =>
      query.eq('roleId', role!._id),
    ).collect()).map((row) => row.permission),
  )
  let created = 0
  for (const permission of permissions) {
    if (existing.has(permission)) continue
    await ctx.db.insert('iamRolePermissions', { roleId: role._id, permission, insertedAt: Date.now() })
    created += 1
  }
  return created
}

export async function seedBuiltinRoles(ctx: Pick<MutationCtx, 'db'>): Promise<number> {
  return (
    await ensureBuiltinRole(ctx, 'admin', '管理员', ['*'])
  ) + (
    await ensureBuiltinRole(ctx, 'sales', '销售业务员', SALES_ROLE_PERMISSIONS)
  )
}
