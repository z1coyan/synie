// bun app/components/synie-permission-sheet/permission-sheet-checks.ts 可直接运行的纯函数自检
import {
  CANONICAL_ACTIONS,
  buildSubmit,
  coveredBy,
  groupByDomain,
  groupCodes,
  initialChecked,
  searchGroups,
  splitActions,
  triState,
} from './matrix'
import type { CatalogGroup, GrantedRow } from './matrix'
import { resourceLabel } from './permission-labels'

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const catalog: CatalogGroup[] = [
  { prefix: 'sys.role', label: '角色', actions: ['create', 'read', 'update', 'delete'] },
  { prefix: 'sys.audit_log', actions: ['read'] },
  { prefix: 'sales.order', actions: ['create', 'read', 'audit'] },
]
const allCodes = catalog.flatMap(groupCodes)

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

// —— groupByDomain ——
eq(groupByDomain(catalog).map((b) => b.domain), ['sys', 'sales'], 'groupByDomain 域顺序')
eq(groupByDomain(catalog)[0].groups.map((g) => g.prefix), ['sys.role', 'sys.audit_log'], 'groupByDomain 组内顺序')

// —— splitActions:固定列 10 动作规范序在前,其余(工作流码)进"更多" ——
eq(CANONICAL_ACTIONS.length, 10, '固定列恰为默认动作集 10 列')
eq(
  splitActions(['read', 'audit', 'create', 'batch_print']),
  { fixed: ['create', 'read', 'batch_print'], extra: ['audit'] },
  'splitActions 固定列规范序+额外动作原序'
)
eq(splitActions(['create', 'read']), { fixed: ['create', 'read'], extra: [] }, 'splitActions 无额外动作')
eq(splitActions(['audit', 'close']), { fixed: [], extra: ['audit', 'close'] }, 'splitActions 纯工作流动作')

// —— triState ——
const codes3 = ['sys.role:create', 'sys.role:read', 'sys.role:update']
eq(triState(codes3, new Set(codes3)), 'all', 'triState 全勾')
eq(triState(codes3, new Set(['sys.role:read'])), 'some', 'triState 半选')
eq(triState(codes3, new Set()), 'none', 'triState 未勾')
eq(triState([], new Set()), 'none', 'triState 空集按未勾(调用方禁用该全选框)')
eq(triState(codes3, new Set([...codes3, 'other:read'])), 'all', 'triState 集外码不影响判定')

// —— searchGroups:按展示标签(catalog label 优先,回落静态映射)或 prefix 匹配 ——
const labelOf = (g: CatalogGroup) => resourceLabel(g.prefix, g.label)
eq(searchGroups(catalog, '角色', labelOf).map((g) => g.prefix), ['sys.role'], 'searchGroups 命中 catalog label')
eq(searchGroups(catalog, '日志', labelOf).map((g) => g.prefix), ['sys.audit_log'], 'searchGroups 回落静态映射命中')
eq(searchGroups(catalog, 'SALES.', labelOf).map((g) => g.prefix), ['sales.order'], 'searchGroups prefix 大小写不敏感')
eq(searchGroups(catalog, '  角色  ', labelOf).map((g) => g.prefix), ['sys.role'], 'searchGroups 关键词 trim')
eq(searchGroups(catalog, '', labelOf), [], 'searchGroups 空关键词不过滤(调用方据此退回域视图)')
eq(searchGroups(catalog, '不存在', labelOf), [], 'searchGroups 无命中')

// —— initialChecked ——
const rows1: GrantedRow[] = [
  { id: 'r1', permission: 'sys.role:read' },
  { id: 'r2', permission: 'sales.*' },
]
const checked1 = initialChecked(catalog, rows1)
eq(checked1.has('sys.role:read'), true, 'initialChecked 精确码')
eq(checked1.has('sales.order:audit'), true, 'initialChecked 域通配展开')
eq(checked1.has('sys.role:create'), false, 'initialChecked 未授予不勾')

// —— buildSubmit:提交集 = 勾选的具体码 − 存量通配行展开集,按 catalog 序 ——
eq(
  buildSubmit(catalog, [], new Set(['sys.role:read'])),
  ['sys.role:read'],
  'buildSubmit 纯新增'
)
eq(
  buildSubmit(catalog, [{ id: 'r1', permission: 'sys.role:read' }], new Set(['sys.role:read'])),
  ['sys.role:read'],
  'buildSubmit 存量精确码仍勾选则照传(后端 diff 出不变)'
)
eq(buildSubmit(catalog, [], new Set()), [], 'buildSubmit 全取消传空集(后端清空目录内具体码)')

const wildRows: GrantedRow[] = [{ id: 'w1', permission: 'sys.role:*' }]
const allRole = ['sys.role:create', 'sys.role:read', 'sys.role:update', 'sys.role:delete']
eq(
  buildSubmit(catalog, wildRows, new Set([...allRole, 'sys.audit_log:read'])),
  ['sys.audit_log:read'],
  'buildSubmit 通配覆盖的码不进提交集(避免重复落成具体行)'
)
eq(
  buildSubmit(catalog, wildRows, new Set(['sys.role:create', 'sys.role:read', 'sys.audit_log:read'])),
  ['sys.audit_log:read'],
  'buildSubmit 通配部分取消:覆盖码一律不传(通配行后端保留,取消不生效)'
)

// 目录外陈旧码:初态不会含它;即便 checked 被污染,flatMap catalog 构造也天然排除
eq(
  buildSubmit(catalog, [{ id: 's1', permission: 'legacy.thing:read' }], new Set(['legacy.thing:read'])),
  [],
  'buildSubmit 目录外码不进提交集(fail-safe)'
)

// —— 全域通配 `*`(内置 admin 角色的授权形态) ——
const globalRows: GrantedRow[] = [{ id: 'g1', permission: '*' }]
const checkedAll = initialChecked(catalog, globalRows)
eq([...checkedAll].sort(), [...allCodes].sort(), 'initialChecked 全域通配全勾')
eq(buildSubmit(catalog, globalRows, checkedAll), [], 'buildSubmit 全域通配下提交空集(通配行后端保留)')

// —— 提交集顺序 = catalog 序(与勾选插入顺序无关),保证快照可比对 ——
eq(
  buildSubmit(catalog, [], new Set(['sales.order:read', 'sys.role:create', 'sales.order:audit'])),
  ['sys.role:create', 'sales.order:read', 'sales.order:audit'],
  'buildSubmit 输出按 catalog 序'
)

console.log('permission-sheet-checks ok')
