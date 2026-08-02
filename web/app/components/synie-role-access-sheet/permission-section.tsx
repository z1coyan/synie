// 功能权限区：自原 SyniePermissionSheet 平移（搜索/域导航/权限矩阵/三态全选），
// 新增资源行锚点 id 与跳转高亮（供菜单区注解点击定位）。
import { Button, Checkbox, Chip, SearchField, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { QueryState } from '../synie-query-state/QueryState'
import {
  CANONICAL_ACTIONS,
  groupByDomain,
  groupCodes,
  searchGroups,
  splitActions,
  triState,
} from '../synie-permission-sheet/matrix'
import type { CatalogGroup, GrantedRow } from '../synie-permission-sheet/matrix'
import { actionLabel, domainLabel, resourceLabel } from '../synie-permission-sheet/permission-labels'
import { permRowId } from './access-sheet'

export interface PermissionSectionProps {
  /** null=加载中；error 与 loaded 互斥（无查看权限时本组件不被渲染） */
  loaded: { catalog: CatalogGroup[]; rows: GrantedRow[] } | null
  error: string | null
  onRetry: () => void
  checked: Set<string>
  /** 交互禁用（只读或保存中） */
  disabled: boolean
  keyword: string
  onKeywordChange: (v: string) => void
  domain: string | null
  onDomainChange: (d: string) => void
  expanded: Set<string>
  onToggle: (code: string, selected: boolean) => void
  onToggleMany: (codes: string[], selected: boolean) => void
  onToggleExpand: (prefix: string) => void
  /** 跳转高亮的资源行（短时闪现后由容器清空） */
  highlightPrefix: string | null
}

/** MatrixTable 需要的外部状态与回调，由本组件持有（搜索视图与域视图共用） */
interface MatrixCtx {
  checked: Set<string>
  disabled: boolean
  expanded: Set<string>
  highlightPrefix: string | null
  toggle: (code: string, selected: boolean) => void
  toggleMany: (codes: string[], selected: boolean) => void
  toggleExpand: (prefix: string) => void
}

/** 某域/某搜索结果分组的一张权限矩阵：行=资源，列=固定 10 动作 + 行尾"更多" */
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
                <Table.Row
                  key={g.prefix}
                  className={
                    ctx.highlightPrefix === g.prefix
                      ? 'bg-surface-secondary transition-colors'
                      : 'transition-colors'
                  }
                >
                  <Table.Cell>
                    {/* 锚点挂在单元格内层：react-aria Table.Row 会覆盖自带的 id，行上挂 id 无效 */}
                    <div id={permRowId(g.prefix)} className="flex items-center gap-1.5">
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

export function PermissionSection(props: PermissionSectionProps) {
  const { checked, disabled, loaded } = props

  const buckets = loaded ? groupByDomain(loaded.catalog) : []
  // 选中域兜底:domain 未设或已不存在时取第一个域
  const activeDomain = buckets.some((b) => b.domain === props.domain) ? props.domain : buckets[0]?.domain
  const searching = props.keyword.trim() !== ''
  const searchBuckets = searching
    ? groupByDomain(searchGroups(loaded?.catalog ?? [], props.keyword, (g) => resourceLabel(g.prefix, g.label)))
    : []

  const ctx: MatrixCtx = {
    checked,
    disabled,
    expanded: props.expanded,
    highlightPrefix: props.highlightPrefix,
    toggle: props.onToggle,
    toggleMany: props.onToggleMany,
    toggleExpand: props.onToggleExpand,
  }

  return (
    <section aria-label="功能权限" className="flex flex-col gap-4">
      <p className="text-xs text-ink-500">「菜单可见性」页签只管导航入口，不拦网址直达；能不能操作由本区决定</p>
      {props.error ? (
        <QueryState
          error={{ message: props.error }}
          errorTitle="权限数据加载失败"
          onRetry={props.onRetry}
        />
      ) : !loaded ? (
        <QueryState isPending />
      ) : (
        <div className="flex flex-col gap-4">
          <SearchField
            aria-label="搜索资源"
            value={props.keyword}
            onChange={props.onKeywordChange}
            className="w-full lg:w-72"
          >
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
                  groupCodes(g).some((c) => checked.has(c)),
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
                      onChange={(selected: boolean) => props.onToggleMany(domainCodes, selected)}
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
                        props.onDomainChange(bucket.domain)
                        props.onKeywordChange('')
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
    </section>
  )
}
