# 角色权限配置(SyniePermissionSheet)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 角色管理补上权限配置能力——catalog 驱动的勾选矩阵,独立宽 Sheet,角色列表行菜单入口。

**Architecture:** 纯前端三件套:`matrix.ts` 纯函数层(通配匹配/勾选初态/保存 diff,与后端 `SynieCore.Authz.Permission` 语义对齐)+ `SyniePermissionSheet.tsx`(Pro Sheet 外壳 + OSS Table/Checkbox 矩阵)+ 角色页接入(myPermissions 门控 + 现成 rowActions 入口)。后端零改动,消费既有 `permissionCatalog` / `sysRolePermissions` / `createSysRolePermission` / `destroySysRolePermission`。

**Tech Stack:** React 19 + TanStack Start + `@heroui/react` v3(Table/Checkbox/Button/Spinner/toast)+ `@heroui-pro/react`(Sheet/EmptyState)+ gqlFetch(`~/lib/graphql`)。

**Spec:** `docs/superpowers/specs/2026-07-09-role-permission-sheet-design.md`

## Global Constraints

- 项目第一语言中文:UI 文案、代码注释、commit message 均中文;commit 尾注 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- HeroUI v3 约定:子组件点号(`Sheet.Content`、`Table.Row`);交互用 `onPress` 不用 `onClick`;基础组件从 `@heroui/react` 导入,Sheet/EmptyState 从 `@heroui-pro/react` 导入。
- 移动端断点统一 `lg`(1024px);非幂等请求一律 toast 反馈;所有请求做错误处理且报错信息可排查。
- 前端闸门(在 `web/` 目录下跑):`bunx tsc --noEmit` 与 `bun app/components/synie-permission-sheet/permission-sheet-checks.ts`,两者全绿才算过。
- 后端零改动;不新增依赖。
- worktree 环境:`web/node_modules` 软链主 checkout(`ln -s /home/zyan/code/synie/web/node_modules web/node_modules`),**不要**在 worktree 里 `bun install`(Pro 包需 token 会拉到占位包)。`tsc` 报 `routeTree.gen.ts` 缺失属环境噪音,起一次 `vite dev` 即生成。
- 主 checkout 的 dev 服务占 3000(vite)/4000(phoenix),worktree 起服务前先 `ss -tlnp | grep -E ':(3000|4000)\b'` 探测,被占则按 Task 4 的临时改口方案避让。
- 非交互 shell 里 `mix` 不在 PATH:`export PATH="$(ls -d ~/.elixir-install/installs/otp/*/bin) $(ls -d ~/.elixir-install/installs/elixir/*/bin):$PATH"` 风格先补(两个 bin 目录以实际 `ls ~/.elixir-install/installs/*/` 为准)。

---

### Task 1: matrix.ts 纯函数层(TDD)

**Files:**
- Create: `web/app/components/synie-permission-sheet/matrix.ts`
- Test: `web/app/components/synie-permission-sheet/permission-sheet-checks.ts`

**Interfaces:**
- Consumes: 无(纯函数,零依赖)
- Produces(Task 2 依赖,签名必须一致):
  - `interface CatalogGroup { prefix: string; actions: string[] }`
  - `interface GrantedRow { id: string; permission: string }`
  - `interface MatrixDiff { toCreate: string[]; toDestroyIds: string[] }`
  - `groupByDomain(catalog: CatalogGroup[]): { domain: string; groups: CatalogGroup[] }[]`
  - `actionColumns(catalog: CatalogGroup[]): string[]`
  - `coveredBy(code: string, granted: Set<string>): boolean`
  - `initialChecked(catalog: CatalogGroup[], rows: GrantedRow[]): Set<string>`
  - `buildDiff(catalog: CatalogGroup[], rows: GrantedRow[], checked: Set<string>): MatrixDiff`

- [ ] **Step 0: worktree 环境准备(若已就绪跳过)**

```bash
[ -e web/node_modules ] || ln -s /home/zyan/code/synie/web/node_modules web/node_modules
```

- [ ] **Step 1: 写失败的 checks**

创建 `web/app/components/synie-permission-sheet/permission-sheet-checks.ts`(完整内容):

```ts
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
eq(coveredBy('sys.role:read', new Set(['sales.*', 'sys.user:read'])), false, 'coveredBy 不命中')
eq(coveredBy('malformed', new Set(['malformed'])), true, 'coveredBy 无冒号码仅精确匹配')
eq(coveredBy('malformed', new Set(['*'])), false, 'coveredBy 无冒号码不吃通配')

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

console.log('permission-sheet-checks ok')
```

- [ ] **Step 2: 跑 checks 确认失败**

```bash
cd web && bun app/components/synie-permission-sheet/permission-sheet-checks.ts
```

Expected: FAIL——`Cannot find module './matrix'`(模块尚不存在)。

- [ ] **Step 3: 实现 matrix.ts**

创建 `web/app/components/synie-permission-sheet/matrix.ts`(完整内容):

```ts
// 权限矩阵纯函数层:通配匹配、勾选初态、保存 diff。
// 通配语义与后端 SynieCore.Authz.Permission 对齐:`前缀:*`(资源全部动作)、`域.*`(域全部码)。

export interface CatalogGroup {
  prefix: string // 如 "sys.role"
  actions: string[] // 如 ["create", "read"]
}

export interface GrantedRow {
  id: string
  permission: string // 具体码或通配码
}

export interface MatrixDiff {
  toCreate: string[] // 需新建的具体权限码
  toDestroyIds: string[] // 需删除的 sys_role_permission 行 id
}

/** 展示规范序 = 后端 Permission.default_actions;catalog 出现的非标动作(工作流码)排尾 */
export const CANONICAL_ACTIONS = [
  'create', 'read', 'update', 'delete', 'print', 'import',
  'export', 'batch_delete', 'batch_update', 'batch_print',
]

/** 按 prefix 首段分域,保持 catalog 原有顺序 */
export function groupByDomain(catalog: CatalogGroup[]): { domain: string; groups: CatalogGroup[] }[] {
  const out: { domain: string; groups: CatalogGroup[] }[] = []
  for (const g of catalog) {
    const domain = g.prefix.split('.')[0]
    const bucket = out.find((b) => b.domain === domain)
    if (bucket) bucket.groups.push(g)
    else out.push({ domain, groups: [g] })
  }
  return out
}

/** 列 = catalog 全部动作并集:规范序在前,非标动作按首现顺序排尾 */
export function actionColumns(catalog: CatalogGroup[]): string[] {
  const seen = [...new Set(catalog.flatMap((g) => g.actions))]
  const canonical = CANONICAL_ACTIONS.filter((a) => seen.includes(a))
  const extra = seen.filter((a) => !CANONICAL_ACTIONS.includes(a))
  return [...canonical, ...extra]
}

// "sales.order:audit" 的候选:自身、"sales.order:*"、"sales.*"(对齐后端 Permission.candidates/1)
function candidates(code: string): string[] {
  const i = code.indexOf(':')
  if (i < 0) return [code]
  const prefix = code.slice(0, i)
  const j = prefix.indexOf('.')
  return j < 0 ? [code, `${prefix}:*`] : [code, `${prefix}:*`, `${prefix.slice(0, j)}.*`]
}

/** granted(具体码或通配码集合)是否覆盖给定具体码 */
export function coveredBy(code: string, granted: Set<string>): boolean {
  return candidates(code).some((c) => granted.has(c))
}

/** 勾选初态:catalog 每个码,granted 行有精确码或通配覆盖即勾上 */
export function initialChecked(catalog: CatalogGroup[], rows: GrantedRow[]): Set<string> {
  const granted = new Set(rows.map((r) => r.permission))
  const checked = new Set<string>()
  for (const g of catalog) {
    for (const a of g.actions) {
      const code = `${g.prefix}:${a}`
      if (coveredBy(code, granted)) checked.add(code)
    }
  }
  return checked
}

/**
 * 保存 diff:
 * - 精确行:码被取消 → 删;仍勾选 → 保留。
 * - 通配行:展开集全部仍勾选 → 保留;有任一被取消 → 删行,靠 toCreate 补齐其余逐码。
 * - 目录外的陈旧码不渲染也不动(fail-safe)。
 * - toCreate = 勾选集中未被任何保留行覆盖的码。
 */
export function buildDiff(catalog: CatalogGroup[], rows: GrantedRow[], checked: Set<string>): MatrixDiff {
  const catalogCodes = catalog.flatMap((g) => g.actions.map((a) => `${g.prefix}:${a}`))
  const kept = new Set<string>()
  const toDestroyIds: string[] = []

  for (const row of rows) {
    if (row.permission.endsWith('*')) {
      const expansion = catalogCodes.filter((c) => coveredBy(c, new Set([row.permission])))
      if (expansion.every((c) => checked.has(c))) kept.add(row.permission)
      else toDestroyIds.push(row.id)
    } else if (catalogCodes.includes(row.permission)) {
      if (checked.has(row.permission)) kept.add(row.permission)
      else toDestroyIds.push(row.id)
    } else {
      kept.add(row.permission) // 目录外陈旧码:保留不动
    }
  }

  const toCreate = [...checked].filter((c) => !coveredBy(c, kept))
  return { toCreate, toDestroyIds }
}
```

- [ ] **Step 4: 跑 checks 确认通过**

```bash
cd web && bun app/components/synie-permission-sheet/permission-sheet-checks.ts
```

Expected: `permission-sheet-checks ok`

- [ ] **Step 5: tsc 闸门**

```bash
cd web && bunx tsc --noEmit
```

Expected: 无错误(若仅报 `routeTree.gen.ts` 缺失,属环境噪音,起一次 vite dev 生成后重跑)。

- [ ] **Step 6: Commit**

```bash
git add web/app/components/synie-permission-sheet/
git commit -m "feat: 权限矩阵纯函数层——通配匹配/勾选初态/保存 diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 中文标签 + SyniePermissionSheet 组件

**Files:**
- Create: `web/app/components/synie-permission-sheet/permission-labels.ts`
- Create: `web/app/components/synie-permission-sheet/SyniePermissionSheet.tsx`

**Interfaces:**
- Consumes(Task 1):`matrix.ts` 的 `CatalogGroup` / `GrantedRow` / `groupByDomain` / `actionColumns` / `initialChecked` / `buildDiff`
- Produces(Task 3 依赖):
  - `SyniePermissionSheet(props: SyniePermissionSheetProps): JSX.Element`
  - `interface SyniePermissionSheetProps { roleId: string; roleName: string; isOpen: boolean; onOpenChange: (open: boolean) => void; readOnly?: boolean }`

- [ ] **Step 1: 写 permission-labels.ts**

创建 `web/app/components/synie-permission-sheet/permission-labels.ts`(完整内容):

```ts
// 权限矩阵中文标签;漏码原样显示英文(同 logs.tsx 模式),新域/新资源/新动作接入时在此补
export const DOMAIN_LABELS: Record<string, string> = {
  sys: '系统',
  org: '组织',
  base: '基础资料',
}

export const RESOURCE_LABELS: Record<string, string> = {
  'sys.role': '角色',
  'sys.user_role': '用户角色',
  'sys.role_permission': '角色权限',
  'sys.user_company': '用户公司',
  'sys.audit_log': '操作日志',
  'org.company': '公司',
  'base.unit': '计量单位',
  'base.currency': '币种',
}

export const ACTION_LABELS: Record<string, string> = {
  create: '新增',
  read: '查看',
  update: '编辑',
  delete: '删除',
  print: '打印',
  import: '导入',
  export: '导出',
  batch_delete: '批量删除',
  batch_update: '批量更新',
  batch_print: '批量打印',
}

export const domainLabel = (d: string) => DOMAIN_LABELS[d] ?? d
export const resourceLabel = (p: string) => RESOURCE_LABELS[p] ?? p
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a
```

- [ ] **Step 2: 写 SyniePermissionSheet.tsx**

创建 `web/app/components/synie-permission-sheet/SyniePermissionSheet.tsx`(完整内容)。要点:Sheet 外壳照 SynieRecordDrawer 同构(`Sheet.Backdrop > Content > Dialog > CloseTrigger/Header/Body/Footer`),宽度 `w-full lg:w-[720px]`;Checkbox 结构照 filter-popover.tsx 的 `Checkbox > Checkbox.Content > Checkbox.Control > Checkbox.Indicator`;矩阵表格用 OSS `Table`(`Table.ScrollContainer` 承载横向滚动,首列 `isRowHeader`):

```tsx
import { useEffect, useState } from 'react'
import { Button, Checkbox, Spinner, Table, toast } from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { actionColumns, buildDiff, groupByDomain, initialChecked } from './matrix'
import type { CatalogGroup, GrantedRow } from './matrix'
import { actionLabel, domainLabel, resourceLabel } from './permission-labels'

export interface SyniePermissionSheetProps {
  roleId: string
  roleName: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 页面按 myPermissions 判后传入:true 时矩阵只读、无保存钮 */
  readOnly?: boolean
}

interface Loaded {
  catalog: CatalogGroup[]
  rows: GrantedRow[]
}

// roleId 为服务端签发的 uuid,内插进查询串(同 remote-query.ts 的 filter 先例)。
// list 统一 offset 分页(backend/CLAUDE.md);limit 200 = max_page_size,权限行数量级远小于此,一页取足。
const loadQuery = (roleId: string) => `
  query {
    permissionCatalog { prefix actions }
    sysRolePermissions(filter: { roleId: { eq: "${roleId}" } }, limit: 200, offset: 0) {
      count
      results { id permission }
    }
  }
`

const CREATE = `
  mutation ($input: CreateSysRolePermissionInput!) {
    createSysRolePermission(input: $input) { result { id } errors { message } }
  }
`
const DESTROY = `
  mutation ($id: ID!) {
    destroySysRolePermission(id: $id) { errors { message } }
  }
`

export function SyniePermissionSheet(props: SyniePermissionSheetProps) {
  const { roleId, isOpen } = props
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 打开/换角色/手动重试时重拉;关闭时保留旧数据无碍(重开必然重拉)
  useEffect(() => {
    if (!isOpen || !roleId) return
    let cancelled = false
    setData(null)
    setError(null)
    gqlFetch<{
      permissionCatalog: CatalogGroup[]
      sysRolePermissions: { count: number; results: GrantedRow[] }
    }>(loadQuery(roleId))
      .then((res) => {
        if (cancelled) return
        setData({ catalog: res.permissionCatalog, rows: res.sysRolePermissions.results })
        setChecked(initialChecked(res.permissionCatalog, res.sysRolePermissions.results))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, roleId, reloadKey])

  const toggle = (code: string, selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (selected) next.add(code)
      else next.delete(code)
      return next
    })

  const save = async () => {
    if (!data || !roleId) return
    const diff = buildDiff(data.catalog, data.rows, checked)
    if (diff.toCreate.length === 0 && diff.toDestroyIds.length === 0) {
      props.onOpenChange(false)
      return
    }
    setSaving(true)
    const failed: string[] = []
    // ponytail: 前端逐条并发、聚合报错;量大或需事务性时后端加 bulk action 再切
    await Promise.all([
      ...diff.toCreate.map(async (code) => {
        try {
          const res = await gqlFetch<{ createSysRolePermission: { errors: { message: string }[] | null } }>(
            CREATE,
            { input: { roleId, permission: code } }
          )
          if (res.createSysRolePermission.errors?.length) failed.push(code)
        } catch {
          failed.push(code)
        }
      }),
      ...diff.toDestroyIds.map(async (id) => {
        try {
          const res = await gqlFetch<{ destroySysRolePermission: { errors: { message: string }[] | null } }>(
            DESTROY,
            { id }
          )
          if (res.destroySysRolePermission.errors?.length) failed.push(`删除失败(行 ${id})`)
        } catch {
          failed.push(`删除失败(行 ${id})`)
        }
      }),
    ])
    setSaving(false)
    if (failed.length > 0) {
      toast.danger('权限保存部分失败', { description: failed.join('、') })
      setReloadKey((k) => k + 1) // 重拉真实勾选态,Sheet 不关
    } else {
      toast.success('权限已保存')
      props.onOpenChange(false)
    }
  }

  const columns = data ? actionColumns(data.catalog) : []

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[720px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>配置权限:{props.roleName}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {error ? (
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>权限数据加载失败</EmptyState.Title>
                    <EmptyState.Description>{error}</EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button variant="secondary" onPress={() => setReloadKey((k) => k + 1)}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : !data ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {groupByDomain(data.catalog).map((bucket) => (
                    <section key={bucket.domain}>
                      <h3 className="mb-2 text-sm font-medium text-ink-500">{domainLabel(bucket.domain)}</h3>
                      <Table>
                        <Table.ScrollContainer>
                          <Table.Content aria-label={`${domainLabel(bucket.domain)}权限`}>
                            <Table.Header>
                              <Table.Column isRowHeader>资源</Table.Column>
                              {columns.map((a) => (
                                <Table.Column key={a}>{actionLabel(a)}</Table.Column>
                              ))}
                            </Table.Header>
                            <Table.Body>
                              {bucket.groups.map((g) => (
                                <Table.Row key={g.prefix}>
                                  <Table.Cell>{resourceLabel(g.prefix)}</Table.Cell>
                                  {columns.map((a) => {
                                    const code = `${g.prefix}:${a}`
                                    return (
                                      <Table.Cell key={a}>
                                        {g.actions.includes(a) ? (
                                          <Checkbox
                                            aria-label={code}
                                            isSelected={checked.has(code)}
                                            isDisabled={props.readOnly || saving}
                                            onChange={(selected: boolean) => toggle(code, selected)}
                                          >
                                            <Checkbox.Content>
                                              <Checkbox.Control>
                                                <Checkbox.Indicator />
                                              </Checkbox.Control>
                                            </Checkbox.Content>
                                          </Checkbox>
                                        ) : (
                                          <span className="text-ink-500">—</span>
                                        )}
                                      </Table.Cell>
                                    )
                                  })}
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Content>
                        </Table.ScrollContainer>
                      </Table>
                    </section>
                  ))}
                </div>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              <Sheet.Close>
                <Button variant="secondary" isDisabled={saving}>
                  {props.readOnly ? '关闭' : '取消'}
                </Button>
              </Sheet.Close>
              {!props.readOnly && (
                <Button onPress={save} isPending={saving} isDisabled={!data}>
                  保存
                </Button>
              )}
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}
```

- [ ] **Step 3: 闸门**

```bash
cd web && bunx tsc --noEmit && bun app/components/synie-permission-sheet/permission-sheet-checks.ts
```

Expected: tsc 无错误 + `permission-sheet-checks ok`。若 tsc 报 HeroUI 子组件属性不符(如 `Table.Column` 无 `isRowHeader`),以 `node_modules` 里的类型定义为准修正用法,不要 `any` 压制。

- [ ] **Step 4: Commit**

```bash
git add web/app/components/synie-permission-sheet/
git commit -m "feat: SyniePermissionSheet 权限配置宽抽屉——catalog 勾选矩阵+diff 保存

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 角色页接入(myPermissions 门控 + rowActions 入口)

**Files:**
- Modify: `web/app/routes/_app/system/roles.tsx`

**Interfaces:**
- Consumes(Task 2):`SyniePermissionSheet` / `SyniePermissionSheetProps`
- Consumes(现成):SynieDataGrid 的 `rowActions?: RowAction[]`(`~/components/synie-data-grid/types` 的 `RowAction`,`onAction(row, ctx)`;其 `capability` 门控走本资源 meta capabilities,跨资源码用不上,这里由页面条件传入代替)
- Produces: 无(叶子页面)

- [ ] **Step 1: 修改 roles.tsx**

在现有基础上加三处(myPermissions 拉取、rowActions、Sheet 实例)。修改后关键片段:

```tsx
import { useEffect, useState } from 'react'
// ...既有 import 保持,新增:
import { SyniePermissionSheet } from '~/components/synie-permission-sheet/SyniePermissionSheet'

function RolesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [permRole, setPermRole] = useState<Row | null>(null)
  const [myPerms, setMyPerms] = useState<Set<string>>(new Set())

  // 权限配置入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示
  useEffect(() => {
    gqlFetch<{ myPermissions: string[] }>('query { myPermissions }')
      .then((d) => setMyPerms(new Set(d.myPermissions)))
      .catch((e) => toast.danger('权限信息加载失败', { description: (e as Error).message }))
  }, [])

  const canConfigure = myPerms.has('sys.role_permission:read')
  const canWrite = myPerms.has('sys.role_permission:create') && myPerms.has('sys.role_permission:delete')

  return (
    <>
      {/* ...标题不变... */}
      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysRoles"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={
            canConfigure
              ? [{ key: 'permissions', label: '配置权限', onAction: (row) => setPermRole(row) }]
              : undefined
          }
        />
      </div>

      {/* ...SynieRecordDrawer 不变... */}

      <SyniePermissionSheet
        roleId={permRole?.id ?? ''}
        roleName={String(permRole?.name ?? '')}
        isOpen={permRole !== null}
        onOpenChange={(open) => !open && setPermRole(null)}
        readOnly={!canWrite}
      />
    </>
  )
}
```

- [ ] **Step 2: 闸门**

```bash
cd web && bunx tsc --noEmit && bun app/components/synie-permission-sheet/permission-sheet-checks.ts
```

Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add web/app/routes/_app/system/roles.tsx
git commit -m "feat: 角色页接入权限配置入口——行菜单开 SyniePermissionSheet

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 端到端验证

**Files:** 无新增(验证任务;如需临时改口,改动一律不提交)

**Interfaces:** 消费全部前序任务的成果;产出验证结论。

- [ ] **Step 1: 起后端**

```bash
export PATH="$(echo ~/.elixir-install/installs/otp/*/bin):$(echo ~/.elixir-install/installs/elixir/*/bin):$PATH"
ss -tlnp | grep -E ':(3000|4000)\b' || echo '端口空闲'
```

- 4000 空闲:在 worktree `backend/` 下 `mix deps.get && mix phx.server`(后台跑)。
- 4000 被占(主 checkout 服务在跑):临时改 worktree 的 `backend/config/dev.exs` 端口为 4100、`web/vite.config.ts` proxy target 为 `http://localhost:4100`,验证完 `git checkout -- backend/config/dev.exs web/vite.config.ts` 还原,**绝不提交**。
- Postgres 在 5440(synie-pg 容器),dev config 默认已指向,无需传 PGPORT;数据库与主 checkout 共享,验证用完删除测试数据。

- [ ] **Step 2: 起前端**

```bash
cd web && bun run dev -- --host --port 3100
```

(`--host` 必须带,用户经 Tailscale 100.93.251.66 访问;3100 避开主 checkout 的 3000。首次启动会生成 `routeTree.gen.ts`。)

- [ ] **Step 3: Playwright 走查主流程**

用 playwright MCC 依次验证(base URL `http://localhost:3100`):

1. 登录 admin/admin123,进 `/system/roles`。
2. 新建测试角色(code 如 `e2e_perm_test`)。
3. 该行菜单出现「配置权限」;点开,矩阵按域分组渲染、中文标签正确、资源不具备的动作格显示「—」。
4. 勾选若干权限(至少含两个资源),保存 → 成功 toast、Sheet 关闭。
5. 重新打开该角色的配置权限,勾选态与刚才一致(读得回来)。
6. 取消其中一个勾,保存,再重开验证该码已消失、其余保留。
7. 进 `/system/logs`,确认上述 create/destroy 已进审计日志。
8. 删除测试角色(级联/残留行为如实记录)。

Expected: 全部通过;任何一步失败即停,回任务修复后重跑。

- [ ] **Step 4: 收尾**

```bash
git status
```

Expected: 工作树干净(临时改口已还原);停掉两个 dev 服务。

---

## Self-Review 记录

- Spec 覆盖:矩阵形态(Task 1/2)、入口 rowActions(Task 3)、通配展开与 diff(Task 1)、门控(Task 3)、中文标签(Task 2)、错误处理(Task 2/3)、测试闸门(各任务)、端到端(Task 4)。跟进项 4 条按 spec 保留不实现。
- 类型一致性:`CatalogGroup/GrantedRow/MatrixDiff` 与 `SyniePermissionSheetProps` 在 Task 1→2→3 的 Interfaces 块中签名一致。
- 无占位:所有代码步骤给出完整文件内容或明确修改片段。
