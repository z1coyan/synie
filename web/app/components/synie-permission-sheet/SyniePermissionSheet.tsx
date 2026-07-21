import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Chip, SearchField, Spinner, Table, toast } from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import {
  CANONICAL_ACTIONS,
  buildSubmit,
  groupByDomain,
  groupCodes,
  initialChecked,
  searchGroups,
  splitActions,
  triState,
} from './matrix'
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
  roleId: string
  catalog: CatalogGroup[]
  rows: GrantedRow[]
}

/** MatrixTable 需要的外部状态与回调,由 Sheet 本体持有(搜索视图与域视图共用) */
interface MatrixCtx {
  checked: Set<string>
  disabled: boolean
  expanded: Set<string>
  toggle: (code: string, selected: boolean) => void
  toggleMany: (codes: string[], selected: boolean) => void
  toggleExpand: (prefix: string) => void
}

// roleId 内插进查询串,JSON.stringify 转义(同 remote-query.ts buildOptionsQuery/buildByIdQuery 的转义先例)。
// list 统一 offset 分页(backend/CLAUDE.md);limit 200 = max_page_size,权限行数量级远小于此,一页取足。
const loadQuery = (roleId: string) => `
  query {
    permissionCatalog { prefix label actions }
    sysRolePermissions(filter: { roleId: { eq: ${JSON.stringify(roleId)} } }, limit: 200, offset: 0) {
      count
      results { id permission }
    }
  }
`

// 单次 sync:传目标勾选的具体码集合,后端事务内 diff;通配行与目录外码后端保留(见 matrix.ts buildSubmit)
const SYNC = `
  mutation ($roleId: ID!, $permissions: [String!]!) {
    syncSysRolePermissions(roleId: $roleId, permissions: $permissions)
  }
`

/** 某域/某搜索结果分组的一张权限矩阵:行=资源,列=固定 10 动作 + 行尾"更多" */
function MatrixTable(props: { ariaLabel: string; groups: CatalogGroup[]; ctx: MatrixCtx }) {
  const { groups, ctx } = props

  const check = (code: string) => (
    <Checkbox
      aria-label={code}
      // 表格树内 Table 的 CheckboxContext 只认 slot="selection";slot={null} 退出,否则渲染抛错
      slot={null}
      isSelected={ctx.checked.has(code)}
      isDisabled={ctx.disabled}
      onChange={(selected: boolean) => ctx.toggle(code, selected)}
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  )

  // 三级全选共用:全勾/半选/未勾;无适用码时禁用(如某列在当前组无资源支持)
  const triCheck = (label: string, codes: string[]) => {
    const state = triState(codes, ctx.checked)
    return (
      <Checkbox
        aria-label={label}
        slot={null}
        isSelected={state === 'all'}
        isIndeterminate={state === 'some'}
        isDisabled={ctx.disabled || codes.length === 0}
        onChange={(selected: boolean) => ctx.toggleMany(codes, selected)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
    )
  }

  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={props.ariaLabel}>
          <Table.Header>
            <Table.Column isRowHeader>资源</Table.Column>
            {CANONICAL_ACTIONS.map((a) => {
              // 列头全选:该动作在当前组所有适用资源上的码
              const codes = groups.filter((g) => g.actions.includes(a)).map((g) => `${g.prefix}:${a}`)
              return (
                <Table.Column key={a}>
                  <div className="flex items-center gap-1.5">
                    {triCheck(`全选${actionLabel(a)}`, codes)}
                    {actionLabel(a)}
                  </div>
                </Table.Column>
              )
            })}
            <Table.Column>更多</Table.Column>
          </Table.Header>
          <Table.Body>
            {groups.flatMap((g) => {
              const { fixed, extra } = splitActions(g.actions)
              const isExpanded = ctx.expanded.has(g.prefix)
              const mainRow = (
                <Table.Row key={g.prefix}>
                  <Table.Cell>
                    <div className="flex items-center gap-1.5">
                      {/* 行头全选:该资源全部动作,含"更多"里的 */}
                      {triCheck(`全选${resourceLabel(g.prefix, g.label)}`, groupCodes(g))}
                      {resourceLabel(g.prefix, g.label)}
                    </div>
                  </Table.Cell>
                  {CANONICAL_ACTIONS.map((a) => (
                    <Table.Cell key={a}>
                      {fixed.includes(a) ? check(`${g.prefix}:${a}`) : <span className="text-ink-500">—</span>}
                    </Table.Cell>
                  ))}
                  <Table.Cell>
                    {extra.length > 0 && (
                      <Button size="sm" variant="ghost" onPress={() => ctx.toggleExpand(g.prefix)}>
                        {isExpanded ? '收起' : `更多(${extra.length})`}
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              )
              if (!isExpanded) return [mainRow]
              const moreRow = (
                <Table.Row key={`${g.prefix}:more`}>
                  <Table.Cell colSpan={CANONICAL_ACTIONS.length + 2}>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
                      {extra.map((a) => {
                        const code = `${g.prefix}:${a}`
                        return (
                          <Checkbox
                            key={a}
                            slot={null}
                            isSelected={ctx.checked.has(code)}
                            isDisabled={ctx.disabled}
                            onChange={(selected: boolean) => ctx.toggle(code, selected)}
                          >
                            <Checkbox.Content>
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                              {actionLabel(a)}
                            </Checkbox.Content>
                          </Checkbox>
                        )
                      })}
                    </div>
                  </Table.Cell>
                </Table.Row>
              )
              return [mainRow, moreRow]
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}

export function SyniePermissionSheet(props: SyniePermissionSheetProps) {
  const { roleId, isOpen } = props
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [domain, setDomain] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 关闭动画期间冻结最后一次打开时的角色名:onOpenChange(false) 后父级常把 roleName 跟着
  // 置空(见 roles.tsx 的 setPermRole(null)),若标题实时跟 props,会在 Sheet 退出动画播放期间
  // 闪成「配置权限:」空名。isOpen 为 true 时把 roleName 存入 ref;isOpen 为 false 时标题改读
  // ref 里的快照(从未打开过则退回当前 props),同 SynieRecordDrawer 的 lastOpenRef 模式。
  const lastRoleNameRef = useRef(props.roleName)
  if (isOpen) lastRoleNameRef.current = props.roleName
  const displayRoleName = isOpen ? props.roleName : lastRoleNameRef.current

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
        const { count, results } = res.sysRolePermissions
        // limit 200 = max_page_size;count 超出已取回行数说明单页被截断,若照常渲染会把没
        // 取到的授权行当成"未授予"展示,勾选/保存都会 fail-open 地把它们错误回收掉。
        if (count > results.length) {
          setError('权限行数超出单页容量(200),请联系开发处理')
          return
        }
        setData({ roleId, catalog: res.permissionCatalog, rows: results })
        setChecked(initialChecked(res.permissionCatalog, results))
        // 换角色后视图状态归零:搜索、选中域、"更多"展开行
        setKeyword('')
        setDomain(null)
        setExpanded(new Set())
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, roleId, reloadKey])

  // 换角色时 props.roleId 先于 setData(null) 生效的那一帧,data 仍是上一个角色的:isOpen 为
  // true 时用 data.roleId === roleId 兜底,不匹配就当未加载(走 Spinner 分支),避免闪出上一
  // 角色的勾选;不在渲染期 setState,effect 稍后会自然把 data 重置为 null 再重拉。isOpen 为
  // false(退场动画中)时 roleId 常同步被父级置空,不做该校验,沿用旧数据保持画面不闪空。
  const loaded = isOpen ? (data && data.roleId === roleId ? data : null) : data

  const toggle = (code: string, selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (selected) next.add(code)
      else next.delete(code)
      return next
    })

  // 全选落子:全选 = 展开为具体码逐个加/删,不写通配码(提交集永远只有具体码)
  const toggleMany = (codes: string[], selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const c of codes) {
        if (selected) next.add(c)
        else next.delete(c)
      }
      return next
    })

  const toggleExpand = (prefix: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })

  const save = async () => {
    if (!loaded || !roleId) return
    setSaving(true)
    try {
      await gqlFetch<{ syncSysRolePermissions: string[] }>(SYNC, {
        roleId,
        permissions: buildSubmit(loaded.catalog, loaded.rows, checked),
      })
      toast.success('权限已保存')
      props.onOpenChange(false)
    } catch (e) {
      toast.danger('权限保存失败', { description: (e as Error).message })
      setReloadKey((k) => k + 1) // 重拉真实勾选态,Sheet 不关
    } finally {
      setSaving(false)
    }
  }

  const disabled = props.readOnly || saving
  const buckets = loaded ? groupByDomain(loaded.catalog) : []
  // 选中域兜底:domain 未设或已不存在时取第一个域
  const activeDomain = buckets.some((b) => b.domain === domain) ? domain : buckets[0]?.domain
  const searching = keyword.trim() !== ''
  const searchBuckets = searching
    ? groupByDomain(searchGroups(loaded?.catalog ?? [], keyword, (g) => resourceLabel(g.prefix, g.label)))
    : []

  const ctx: MatrixCtx = { checked, disabled, expanded, toggle, toggleMany, toggleExpand }

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[1080px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>配置权限:{displayRoleName}</Sheet.Heading>
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
              ) : !loaded ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <SearchField aria-label="搜索资源" value={keyword} onChange={setKeyword} className="w-full lg:w-72">
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="搜索资源名 / prefix…" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  <div className="flex flex-col gap-4 lg:flex-row lg:gap-6">
                    {/* 左侧域导航:域名 + 徽标(已授权资源数/总资源数) + 域级三态全选;移动端横排 */}
                    <nav className="flex shrink-0 flex-wrap gap-1 lg:w-44 lg:flex-col lg:items-stretch">
                      {buckets.map((bucket) => {
                        const domainCodes = bucket.groups.flatMap(groupCodes)
                        const granted = bucket.groups.filter((g) =>
                          groupCodes(g).some((c) => checked.has(c))
                        ).length
                        const state = triState(domainCodes, checked)
                        return (
                          <div
                            key={bucket.domain}
                            className={`flex items-center gap-0.5 rounded-md px-1 ${
                              !searching && bucket.domain === activeDomain ? 'bg-surface-secondary' : ''
                            }`}
                          >
                            <Checkbox
                              aria-label={`全选${domainLabel(bucket.domain)}`}
                              isSelected={state === 'all'}
                              isIndeterminate={state === 'some'}
                              isDisabled={disabled || domainCodes.length === 0}
                              onChange={(selected: boolean) => toggleMany(domainCodes, selected)}
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                              </Checkbox.Content>
                            </Checkbox>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="flex-1 justify-start"
                              onPress={() => {
                                setDomain(bucket.domain)
                                setKeyword('')
                              }}
                            >
                              {domainLabel(bucket.domain)}
                              <Chip size="sm" variant="soft" className="ml-auto">
                                {granted}/{bucket.groups.length}
                              </Chip>
                            </Button>
                          </div>
                        )
                      })}
                    </nav>
                    <div className="min-w-0 flex-1">
                      {searching ? (
                        searchBuckets.length === 0 ? (
                          <EmptyState size="md" className="h-48 justify-center">
                            <EmptyState.Header>
                              <EmptyState.Title>无匹配资源</EmptyState.Title>
                              <EmptyState.Description>换个关键词试试</EmptyState.Description>
                            </EmptyState.Header>
                          </EmptyState>
                        ) : (
                          <div className="flex flex-col gap-6">
                            {searchBuckets.map((bucket) => (
                              <section key={bucket.domain}>
                                <h3 className="mb-2 text-sm font-medium text-ink-500">
                                  {domainLabel(bucket.domain)}
                                </h3>
                                <MatrixTable
                                  ariaLabel={`${domainLabel(bucket.domain)}权限`}
                                  groups={bucket.groups}
                                  ctx={ctx}
                                />
                              </section>
                            ))}
                          </div>
                        )
                      ) : (
                        buckets
                          .filter((b) => b.domain === activeDomain)
                          .map((bucket) => (
                            <MatrixTable
                              key={bucket.domain}
                              ariaLabel={`${domainLabel(bucket.domain)}权限`}
                              groups={bucket.groups}
                              ctx={ctx}
                            />
                          ))
                      )}
                    </div>
                  </div>
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
                <Button onPress={save} isPending={saving} isDisabled={!loaded}>
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
