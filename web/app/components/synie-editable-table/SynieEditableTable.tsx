import { useState, type ReactNode } from 'react'
import { Button, Spinner, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { defaultCell } from '../synie-data-grid/SynieDataGrid'
import { useGridMeta } from '../synie-data-grid/meta'
import type { EnumChipColor, GridColumnMeta, Row } from '../synie-data-grid/types'
import { SynieRecordDrawer, type SynieRecordDrawerProps } from '../synie-record-drawer/SynieRecordDrawer'
import type { FieldOverride } from '../synie-record-drawer/fields'
import { appendItem, displayColumns, localRowId, mergeItem, removeItem } from './editable'

export interface EditableColumnOverride {
  label?: string
  /** 不传时数值列(integer/decimal)默认右对齐 */
  align?: 'start' | 'center' | 'end'
  /** 单元格自定义渲染 */
  render?: (value: unknown, row: Row) => ReactNode
  /** enum 列胶囊配色,按枚举值(大写 token)映射;未配的值用 default 灰 */
  enumColors?: Record<string, EnumChipColor>
  /** 追加到 Table.Column/Table.Cell(如定宽 w-24) */
  className?: string
}

export interface SynieEditableTableProps<T extends Row = Row> {
  /** 子条目资源,与后端 GridMeta 白名单同名,如 "glEntryLines" */
  resource: string
  /**
   * 受控条目集合:组件不发任何写请求,增删改全部经 onChange 回给父级,
   * 由父表单提交时一并持久化。新增行 id 为 local: 前缀(isLocalRow 判别)。
   */
  items: T[]
  onChange: (items: T[]) => void
  /** 条目中文名:新增按钮/抽屉标题/空态文案,如 "分录行" */
  label?: string
  /** 表格显示列及其顺序;缺省 = meta 全列(剔 id/时间戳/exclude)。只影响表格,不影响录入表单 */
  columns?: string[]
  /** 表格列与录入表单字段共用剔除(如父外键列 entryId) */
  exclude?: string[]
  /** 表格单元格渲染 override */
  overrides?: Record<string, EditableColumnOverride>
  /** 录入表单字段行为,透传二级 SynieRecordDrawer */
  fields?: Record<string, FieldOverride>
  /** 父表单 view 态传 true:隐藏新增按钮与操作列 */
  readOnly?: boolean
  /** 关掉新增/删除入口(默认开):行由服务端自动产生、只允许改的子表(如编号计数器)用 */
  canCreate?: boolean
  canDelete?: boolean
  /**
   * 写入前校验(如行查重):返回错误文案则 toast 报错、抽屉不关;
   * editing 为 null 表示新增,编辑时校验应跳过自身
   */
  validateItem?: (values: Record<string, unknown>, items: T[], editing: T | null) => string | null | undefined | void
  /** 表单提交值 → 行数据加工(如按 fk id 嵌 join 对象、补计算列);缺省原样写入 */
  transformItem?: (values: Record<string, unknown>, editing: T | null) => Record<string, unknown>
  /** 标题区,缺省用 label;右上角新增按钮左侧的附加内容用 toolbar */
  title?: ReactNode
  toolbar?: ReactNode
  /** 透传二级抽屉宽度等;默认比父抽屉窄一档(lg:w-[420px]) */
  drawerProps?: Pick<SynieRecordDrawerProps, 'contentClassName'>
}

const ALIGN: Record<'start' | 'center' | 'end', string> = {
  start: 'text-start',
  center: 'text-center',
  end: 'text-end',
}

function cellClass(col: GridColumnMeta, o?: EditableColumnOverride): string {
  const align = o?.align ?? (col.type === 'integer' || col.type === 'decimal' ? 'end' : 'start')
  return [ALIGN[align], o?.className].filter(Boolean).join(' ')
}

export function SynieEditableTable<T extends Row = Row>(props: SynieEditableTableProps<T>) {
  const { resource, items, label = '条目', overrides = {}, readOnly = false, canCreate = true, canDelete = true } = props
  const meta = useGridMeta(resource)
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; row: T | null } | null>(null)

  const metaColumns = meta.data?.columns ?? []
  const cols = displayColumns(metaColumns, props.columns, props.exclude)

  const submit = async (values: Record<string, unknown>, mode: 'create' | 'edit') => {
    const editing = mode === 'edit' ? (drawer?.row ?? null) : null
    const msg = props.validateItem?.(values, items, editing)
    if (msg) throw new Error(msg)
    const row = props.transformItem ? props.transformItem(values, editing) : values
    props.onChange(editing ? mergeItem(items, editing, row, metaColumns) : appendItem(items, row, localRowId()))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted">{props.title ?? label}</span>
        <div className="flex items-center gap-2">
          {props.toolbar}
          {!readOnly && canCreate && (
            <Button size="sm" variant="secondary" onPress={() => setDrawer({ mode: 'create', row: null })}>
              新增{label}
            </Button>
          )}
        </div>
      </div>

      {meta.isPending ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner />
        </div>
      ) : meta.isError ? (
        <EmptyState size="sm" className="h-32 justify-center">
          <EmptyState.Header>
            <EmptyState.Title>数据加载失败</EmptyState.Title>
            <EmptyState.Description>{(meta.error as Error).message}</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button size="sm" variant="secondary" onPress={() => meta.refetch()}>
              重试
            </Button>
          </EmptyState.Content>
        </EmptyState>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={String(props.title ?? label)}>
              <Table.Header>
                {cols.map((c, i) => (
                  <Table.Column key={c.name} isRowHeader={i === 0} className={cellClass(c, overrides[c.name])}>
                    {overrides[c.name]?.label ?? c.label}
                  </Table.Column>
                ))}
                {!readOnly && <Table.Column className="w-28 text-end">操作</Table.Column>}
              </Table.Header>
              <Table.Body
                renderEmptyState={() => (
                  <div className="py-6 text-center text-sm text-muted">
                    暂无{label}
                    {!readOnly && ',点击右上角新增'}
                  </div>
                )}
              >
                {items.map((row) => (
                  <Table.Row key={row.id}>
                    {cols.map((c) => (
                      <Table.Cell key={c.name} className={cellClass(c, overrides[c.name])}>
                        <EditableCell col={c} row={row} override={overrides[c.name]} />
                      </Table.Cell>
                    ))}
                    {!readOnly && (
                      <Table.Cell className="text-end">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onPress={() => setDrawer({ mode: 'edit', row })}>
                            编辑
                          </Button>
                          {/* ponytail: 草稿行直接删,父表单保存前都可重录;需要挽回再加确认框 */}
                          {canDelete && (
                            <Button size="sm" variant="ghost" className="text-danger" onPress={() => props.onChange(removeItem(items, row.id))}>
                              删除
                            </Button>
                          )}
                        </div>
                      </Table.Cell>
                    )}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <SynieRecordDrawer
        resource={resource}
        label={label}
        mode={drawer?.mode ?? 'create'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={props.exclude}
        fields={props.fields}
        contentClassName={props.drawerProps?.contentClassName ?? 'w-full lg:w-[420px]'}
        onSubmit={submit}
      />
    </div>
  )
}

/** 单元格:override.render 优先;fk(含无 join 按 id 反查)统一走 defaultCell 的 FkLink */
function EditableCell({ col, row, override }: { col: GridColumnMeta; row: Row; override?: EditableColumnOverride }) {
  const value = row[col.name]
  if (override?.render) return <>{override.render(value, row)}</>
  return <>{defaultCell(col, value, row, override?.enumColors)}</>
}
