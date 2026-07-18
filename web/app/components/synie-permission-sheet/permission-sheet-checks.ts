// bun app/components/synie-permission-sheet/permission-sheet-checks.ts 可直接运行的纯函数自检
import { actionColumns, buildDiff, coveredBy, groupByDomain, initialChecked } from './matrix'
import type { CatalogGroup, GrantedRow } from './matrix'

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const catalog: CatalogGroup[] = [
  { prefix: 'sys.role', actions: ['create', 'read', 'update', 'delete'] },
  { prefix: 'sys.audit_log', actions: ['read'] },
  { prefix: 'sales.order', actions: ['create', 'read', 'audit'] },
]

// —— coveredBy:与后端 Permission.candidates/1 对齐 ——
eq(coveredBy('sys.role:read', new Set(['sys.role:read'])), true, 'coveredBy 精确命中')
eq(coveredBy('sys.role:read', new Set(['sys.role:*'])), true, 'coveredBy 资源通配')
eq(coveredBy('sys.role:read', new Set(['sys.*'])), true, 'coveredBy 域通配')
eq(coveredBy('sys.role:read', new Set(['*'])), true, 'coveredBy 全域通配')
eq(coveredBy('sys.role:read', new Set(['sales.*', 'sys.user:read'])), false, 'coveredBy 不命中')
eq(coveredBy('malformed', new Set(['malformed'])), true, 'coveredBy 无冒号码仅精确匹配')
eq(coveredBy('malformed', new Set(['sys.*'])), false, 'coveredBy 无冒号码不吃域通配')
// 后端候选对无冒号码也含 "*"(Permission.candidates/1 兜底分支),此处对齐
eq(coveredBy('malformed', new Set(['*'])), true, 'coveredBy 无冒号码吃全域通配(对齐后端)')

// —— groupByDomain / actionColumns ——
eq(groupByDomain(catalog).map((b) => b.domain), ['sys', 'sales'], 'groupByDomain 域顺序')
eq(groupByDomain(catalog)[0].groups.map((g) => g.prefix), ['sys.role', 'sys.audit_log'], 'groupByDomain 组内顺序')
eq(actionColumns(catalog), ['create', 'read', 'update', 'delete', 'audit'], 'actionColumns 规范序+非标排尾')

// —— initialChecked ——
const rows1: GrantedRow[] = [
  { id: 'r1', permission: 'sys.role:read' },
  { id: 'r2', permission: 'sales.*' },
]
const checked1 = initialChecked(catalog, rows1)
eq(checked1.has('sys.role:read'), true, 'initialChecked 精确码')
eq(checked1.has('sales.order:audit'), true, 'initialChecked 域通配展开')
eq(checked1.has('sys.role:create'), false, 'initialChecked 未授予不勾')

// —— buildDiff ——
eq(
  buildDiff(catalog, [], new Set(['sys.role:read'])),
  { toCreate: ['sys.role:read'], toDestroyIds: [] },
  'buildDiff 纯新增'
)
eq(
  buildDiff(catalog, [{ id: 'r1', permission: 'sys.role:read' }], new Set()),
  { toCreate: [], toDestroyIds: ['r1'] },
  'buildDiff 纯删除'
)
eq(
  buildDiff(catalog, [{ id: 'r1', permission: 'sys.role:read' }], new Set(['sys.role:read'])),
  { toCreate: [], toDestroyIds: [] },
  'buildDiff 不变'
)

const wildRows: GrantedRow[] = [{ id: 'w1', permission: 'sys.role:*' }]
const allRole = ['sys.role:create', 'sys.role:read', 'sys.role:update', 'sys.role:delete']
eq(
  buildDiff(catalog, wildRows, new Set([...allRole, 'sys.audit_log:read'])),
  { toCreate: ['sys.audit_log:read'], toDestroyIds: [] },
  'buildDiff 通配保留(覆盖码不重复 create)'
)

const partial = new Set(['sys.role:create', 'sys.role:read', 'sys.role:update'])
eq(
  buildDiff(catalog, wildRows, partial),
  { toCreate: ['sys.role:create', 'sys.role:read', 'sys.role:update'], toDestroyIds: ['w1'] },
  'buildDiff 通配拆解补码'
)

const mixed: GrantedRow[] = [
  { id: 'w1', permission: 'sys.role:*' },
  { id: 'e1', permission: 'sys.role:read' },
]
eq(
  buildDiff(catalog, mixed, partial),
  { toCreate: ['sys.role:create', 'sys.role:update'], toDestroyIds: ['w1'] },
  'buildDiff 拆解时精确行已覆盖的码不补'
)

eq(
  buildDiff(catalog, [{ id: 's1', permission: 'legacy.thing:read' }], new Set()),
  { toCreate: [], toDestroyIds: [] },
  'buildDiff 目录外陈旧码保留不动'
)

// —— 全域通配 `*`(内置 admin 角色的授权形态) ——
const globalRows: GrantedRow[] = [{ id: 'g1', permission: '*' }]
const allCodes = catalog.flatMap((g) => g.actions.map((a) => `${g.prefix}:${a}`))
const checkedAll = initialChecked(catalog, globalRows)
eq([...checkedAll].sort(), [...allCodes].sort(), 'initialChecked 全域通配全勾')
eq(
  buildDiff(catalog, globalRows, checkedAll),
  { toCreate: [], toDestroyIds: [] },
  'buildDiff 全域通配全勾时保留不动'
)
const missingOne = new Set(allCodes.filter((c) => c !== 'sys.role:delete'))
eq(
  buildDiff(catalog, globalRows, missingOne),
  { toCreate: [...missingOne], toDestroyIds: ['g1'] },
  'buildDiff 全域通配缺一码即拆行补齐'
)

console.log('permission-sheet-checks ok')
