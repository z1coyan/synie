// bun app/components/synie-permission-sheet/permission-sheet-checks.ts 可直接运行的纯函数自检
// 三元组授权模型（工单 13）：通配已取消，勾选态为 Map（码 → scope），提交集为 { permission, scope }[]。
import {
  CANONICAL_ACTIONS,
  SCOPE_LABELS,
  buildSubmit,
  groupByDomain,
  groupCodes,
  initialGrants,
  scopeOptionsForGrant,
  scopeOptionsOf,
  searchGroups,
  splitActions,
  triState,
} from './matrix'
import type { CatalogGroup, GrantedRow } from './matrix'
import type { DataScope } from '@synie/shared'
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
  { prefix: 'sys.role', label: '角色', actions: ['create', 'read', 'update', 'delete'], supportedScopes: ['all'] },
  { prefix: 'sys.audit_log', actions: ['read'], supportedScopes: ['all'] },
  { prefix: 'mfg.demand', label: '需求单', actions: ['create', 'read', 'audit'], supportedScopes: ['all', 'deptTree', 'self'] },
  { prefix: 'sys.file', label: '附件', actions: ['read'], supportedScopes: ['all', 'self'] },
]

// —— groupByDomain ——
eq(groupByDomain(catalog).map((b) => b.domain), ['sys', 'mfg'], 'groupByDomain 域顺序')
eq(groupByDomain(catalog)[0].groups.map((g) => g.prefix), ['sys.role', 'sys.audit_log', 'sys.file'], 'groupByDomain 组内顺序')

// —— splitActions:固定列八动作规范序在前,其余进"更多" ——
eq(CANONICAL_ACTIONS.length, 8, '固定列恰为封闭八动作')
eq(
  splitActions(['read', 'audit', 'create', 'batch_print']),
  { fixed: ['read', 'create', 'audit'], extra: ['batch_print'] },
  'splitActions 固定列规范序+额外动作原序'
)
eq(splitActions(['create', 'read']), { fixed: ['read', 'create'], extra: [] }, 'splitActions 无额外动作')
eq(splitActions(['audit', 'close']), { fixed: ['audit'], extra: ['close'] }, 'splitActions 折叠后的命令键进更多')

// —— triState:checked 只需能回答 has(code)（Set 与 Map 均可） ——
const codes3 = ['sys.role:create', 'sys.role:read', 'sys.role:update']
eq(triState(codes3, new Map(codes3.map((c) => [c, 'all']))), 'all', 'triState Map 全勾')
eq(triState(codes3, new Map([['sys.role:read', 'dept']])), 'some', 'triState Map 半选')
eq(triState(codes3, new Map()), 'none', 'triState Map 未勾')
eq(triState(codes3, new Set(['sys.role:read'])), 'some', 'triState Set 仍可用（菜单区共用）')
eq(triState([], new Map()), 'none', 'triState 空集按未勾(调用方禁用该全选框)')

// —— searchGroups:按展示标签(catalog label 优先,回落静态映射)或 prefix 匹配 ——
const labelOf = (g: CatalogGroup) => resourceLabel(g.prefix, g.label)
eq(searchGroups(catalog, '角色', labelOf).map((g) => g.prefix), ['sys.role'], 'searchGroups 命中 catalog label')
eq(searchGroups(catalog, '日志', labelOf).map((g) => g.prefix), ['sys.audit_log'], 'searchGroups 回落静态映射命中')
eq(searchGroups(catalog, 'MFG.', labelOf).map((g) => g.prefix), ['mfg.demand'], 'searchGroups prefix 大小写不敏感')
eq(searchGroups(catalog, '  角色  ', labelOf).map((g) => g.prefix), ['sys.role'], 'searchGroups 关键词 trim')
eq(searchGroups(catalog, '', labelOf), [], 'searchGroups 空关键词不过滤(调用方据此退回域视图)')
eq(searchGroups(catalog, '不存在', labelOf), [], 'searchGroups 无命中')

// —— scopeOptionsOf:仅 all/空集不渲染范围控件；目录不再广告 leftover dept ——
eq(scopeOptionsOf(catalog[0]), null, 'scopeOptionsOf 仅 all 返回 null（global 资源无范围控件）')
eq(scopeOptionsOf({ prefix: 'x.y', actions: ['read'], supportedScopes: [] }), null, 'scopeOptionsOf 空集返回 null')
eq(scopeOptionsOf(catalog[2]), ['all', 'deptTree', 'self'], 'scopeOptionsOf 部门+属主维度')
eq(scopeOptionsOf(catalog[3]), ['all', 'self'], 'scopeOptionsOf owner 维度')
eq(
  scopeOptionsOf({ prefix: 'x.z', actions: ['read'], supportedScopes: ['dept'] }),
  null,
  'scopeOptionsOf leftover dept 不作为新授选项'
)
eq(
  scopeOptionsForGrant(
    { prefix: 'mfg.demand', actions: ['read'], supportedScopes: ['all', 'deptTree', 'self'] },
    'dept',
  ),
  ['all', 'deptTree', 'self', 'dept'],
  'scopeOptionsForGrant leftover dept 可回读'
)
eq(
  // 模拟 wire 上的非法值（granted 第一期不开放）：类型外注入，验证运行时过滤
  scopeOptionsOf({ prefix: 'x.w', actions: ['read'], supportedScopes: ['all', 'granted' as DataScope] }),
  null,
  'scopeOptionsOf 过滤未知范围值（granted 第一期不开放）'
)
eq(
  Object.keys(SCOPE_LABELS).sort(),
  ['all', 'dept', 'deptTree', 'self'],
  'SCOPE_LABELS 覆盖四个 DataScope（含 leftover dept）'
)

// —— initialGrants:目录内精确码 → scope；目录外码不收 ——
const rows1: GrantedRow[] = [
  { id: 'r1', permission: 'sys.role:read', scope: 'all' },
  { id: 'r2', permission: 'mfg.demand:read', scope: 'dept' },
  { id: 'r3', permission: 'legacy.thing:read', scope: 'all' },
]
const grants1 = initialGrants(catalog, rows1)
eq(grants1.get('sys.role:read'), 'all', 'initialGrants 精确码带范围')
eq(grants1.get('mfg.demand:read'), 'dept', 'initialGrants leftover dept 范围回读')
eq(grants1.has('legacy.thing:read'), false, 'initialGrants 目录外码不收')
eq(grants1.has('sys.role:create'), false, 'initialGrants 未授予不勾')
eq(grants1.size, 2, 'initialGrants 只收目录内码')

// —— buildSubmit:勾选码按 catalog 序展开为 { permission, scope }[] ——
eq(
  buildSubmit(catalog, new Map([['sys.role:read', 'all']])),
  [{ permission: 'sys.role:read', scope: 'all' }],
  'buildSubmit 纯新增三元组'
)
eq(buildSubmit(catalog, new Map()), [], 'buildSubmit 全取消传空集(后端清空目录内码)')
eq(
  buildSubmit(catalog, new Map([['mfg.demand:read', 'dept'], ['mfg.demand:create', 'deptTree']])),
  [
    { permission: 'mfg.demand:create', scope: 'deptTree' },
    { permission: 'mfg.demand:read', scope: 'dept' },
  ],
  'buildSubmit leftover dept 不钳成 all'
)
// 提交集顺序 = catalog 序（与勾选插入顺序无关），保证快照可比对
eq(
  buildSubmit(catalog, new Map([['mfg.demand:read', 'all'], ['sys.role:create', 'all'], ['mfg.demand:audit', 'self']])),
  [
    { permission: 'sys.role:create', scope: 'all' },
    { permission: 'mfg.demand:read', scope: 'all' },
    { permission: 'mfg.demand:audit', scope: 'self' },
  ],
  'buildSubmit 输出按 catalog 序'
)
// scope 不在该组 supportedScopes 内 → 钳回 'all'（fail-safe：服务端会拒授目录不支持的范围）
eq(
  buildSubmit(catalog, new Map([['sys.role:read', 'dept']])),
  [{ permission: 'sys.role:read', scope: 'all' }],
  'buildSubmit 范围越界钳回 all（global 资源不产出必败请求）'
)
eq(
  buildSubmit(catalog, new Map([['sys.file:read', 'deptTree']])),
  [{ permission: 'sys.file:read', scope: 'all' }],
  'buildSubmit owner 资源授 deptTree 钳回 all'
)
eq(
  buildSubmit(catalog, new Map([['sys.file:read', 'self']])),
  [{ permission: 'sys.file:read', scope: 'self' }],
  'buildSubmit 合法 self 范围透传'
)
// 目录外码：Map 被污染也天然排除（flatMap catalog 构造）
eq(
  buildSubmit(catalog, new Map([['legacy.thing:read', 'all']])),
  [],
  'buildSubmit 目录外码不进提交集（fail-safe）'
)

console.log('permission-sheet-checks ok')
