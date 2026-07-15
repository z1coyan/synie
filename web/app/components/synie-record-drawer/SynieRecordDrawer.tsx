import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseDate, parseDateTime } from '@internationalized/date'
import {
  Button,
  Calendar,
  DateField,
  DatePicker,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Spinner,
  Switch,
  TextField,
  toast,
} from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import { cellText } from '../synie-data-grid/format'
import { useGridMeta } from '../synie-data-grid/meta'
import { UUID_RE, buildRowQuery } from '../synie-data-grid/query'
import type { GridColumnMeta, LocalGridMeta, Row } from '../synie-data-grid/types'
import { RemoteDialogSelect } from '../synie-remote-select/RemoteDialogSelect'
import { RemoteSelect } from '../synie-remote-select/RemoteSelect'
import type { RemoteSourceConfig } from '../synie-remote-select/remote-query'
import { FkLink } from './fk-preview'
import {
  collectValues,
  initialValues,
  isFieldDisabled,
  missingRequired,
  resolveFields,
  visibleFields,
  type DrawerMode,
  type FieldOverride,
  type ResolvedField,
} from './fields'

export interface SynieRecordDrawerProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  mode: DrawerMode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 资源中文名,标题拼为 新增{label}/编辑{label}/{label}详情 */
  label?: string
  /** view/edit 数据源:直接用表格行数据,不按 id 重查 */
  row?: Row | null
  /** 没有现成行数据时(fk 速览等)按 id 自查一行;row 优先 */
  rowId?: string
  exclude?: string[]
  fields?: Record<string, FieldOverride>
  /** 本地列/字段定义,提供时跳过 GridMeta 查询(resource 仅作缓存 key/标题用途) */
  meta?: LocalGridMeta
  /** create/edit 提交;resolve 即成功(组件关抽屉),throw 则 toast 且不关 */
  onSubmit?: (values: Record<string, unknown>, mode: 'create' | 'edit') => Promise<void>
  /** view 态 footer 显示「编辑」按钮,点击回调(页面自行切 mode) */
  onEdit?: () => void
  /** create/edit 态提交按钮文案,默认「保存」(如导入表单的「解析」) */
  submitLabel?: string
  /** view 态 footer 附加动作(渲染在「关闭」之后),如导入记录的「导入」主按钮 */
  footerActions?: (mode: DrawerMode, row: Row | null | undefined) => ReactNode
  /** Sheet.Content 宽度样式 */
  contentClassName?: string
  /**
   * 字段栅格之前的头部内容(如金额主视觉/概要卡、承兑票面区),占满整行;
   * 入参是冻结后的 mode/row(与 extraContent 同一套快照,退场动画期间不闪),
   * values/patchValues 同 extraContent(表单草稿读写,view 态分别为空对象/no-op)
   */
  headerContent?: (
    mode: DrawerMode,
    row: Row | null | undefined,
    values: Record<string, unknown>,
    patchValues: (patch: Record<string, unknown>) => void,
  ) => ReactNode
  /**
   * meta 列之外的附加内容(如多对多关联控件),渲染在字段栅格末尾、占满整行;
   * 状态由页面自持,提交在页面 onSubmit 里自行处理。入参是冻结后的 mode/row(退场动画期间不闪),
   * values 为当前表单草稿(view 态为空对象),供附加内容按表单字段联动(如按公司过滤科目候选);
   * patchValues 第 4 参:向表单草稿并入补丁(view 态为 no-op),供内嵌子表「从明细汇总带出」等场景回写。
   */
  extraContent?: (
    mode: DrawerMode,
    row: Row | null | undefined,
    values: Record<string, unknown>,
    patchValues: (patch: Record<string, unknown>) => void,
  ) => ReactNode
}

// Tailwind v4 JIT 扫不到动态拼接类名,1-12 静态映射
const COL_SPAN: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  9: 'lg:col-span-9',
  10: 'lg:col-span-10',
  11: 'lg:col-span-11',
  12: 'lg:col-span-12',
}

// 非法日期串回落 null,不让整个抽屉崩掉
const safeParseDate = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

// datetime 草稿是本地 YYYY-MM-DDTHH:mm:ss(fields.ts toLocalDateTime 产出)
const safeParseDateTime = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  try {
    return parseDateTime(v)
  } catch {
    return null
  }
}

// 稳定空数组回退:remoteMeta.data?.columns 未就绪时若每次渲染都 `?? []` 新建数组,
// 会让下方以 columns 为依赖的 effect 每次渲染都判定"变了",存在自激重渲染风险
const EMPTY_COLUMNS: GridColumnMeta[] = []

export function SynieRecordDrawer(props: SynieRecordDrawerProps) {
  const { resource, mode, isOpen, exclude, label = '', contentClassName = 'w-full lg:w-[480px]' } = props
  const remoteMeta = useGridMeta(resource, !props.meta) // 本地模式不发请求
  const columns = props.meta?.columns ?? remoteMeta.data?.columns ?? EMPTY_COLUMNS
  const metaPending = !props.meta && remoteMeta.isPending
  const metaError = !props.meta && remoteMeta.isError

  // rowId 自取数:row 未给时按 id 查一行(列集取自 meta,fk join 一并带回)。
  // id 非法(白名单反查约定,防拼进查询)按查无处理,不发请求。
  // 本地 meta 模式下该自查路径不适用(无远程 meta 可拼列/查询),wantsFetch 直接置 false:
  // disabled query 永远 isPending,若只挡 enabled 不挡 wantsFetch,rowPending 会恒 true 卡死 spinner。
  const wantsFetch = !props.meta && !props.row && !!props.rowId
  const validId = !!props.rowId && UUID_RE.test(props.rowId)
  const byId = useQuery({
    queryKey: ['rowById', resource, props.rowId],
    enabled: isOpen && wantsFetch && validId && !!remoteMeta.data,
    queryFn: () => {
      const q = buildRowQuery(resource, remoteMeta.data!.columns, {
        limit: 1,
        offset: 0,
        sortLiteral: null,
        filterLiteral: `{id: {eq: ${JSON.stringify(props.rowId)}}}`,
      })
      return gqlFetch<Record<string, { results: Row[] }>>(q).then((d) => d[resource]?.results[0] ?? null)
    },
  })
  const row = props.row ?? byId.data ?? null
  // isPending 含 enabled 未就绪(等 meta)阶段;data === null 是「查过了但没有」(未查完是 undefined)
  const rowPending = wantsFetch && validId && byId.isPending
  const rowMissing = wantsFetch && (!validId || byId.data === null)

  // 关闭动画期间冻结最后一次打开时的内容:onOpenChange(false) 后父级常把 mode 回落
  // 'view'、row 置 undefined,若渲染路径跟着实时切换,会在 Sheet 退出动画播放期间把
  // 详情/表单闪变成空态。isOpen 为 true 时把 { mode, row } 存入 ref;isOpen 为 false 时
  // 渲染改读 ref 里的快照(从未打开过则退回当前 props)。
  // values 重建 effect 与 save() 继续用实际 props——它们只在 isOpen 为 true 时工作,不受影响。
  const lastOpenRef = useRef<{ mode: DrawerMode; row?: Row | null } | null>(null)
  if (isOpen) {
    lastOpenRef.current = { mode, row }
  }
  const frozen = isOpen ? null : lastOpenRef.current
  const renderMode = frozen ? frozen.mode : mode
  const renderRow = frozen ? frozen.row : row

  const fields = resolveFields(columns, renderMode, exclude, props.fields)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  // 打开/换行/换模式时重建草稿(view 不用草稿,直接读 row)。
  // props.fields/exclude 常为内联字面量,进依赖会在父级每次渲染时重置用户输入;
  // 初值只取决于列类型与行数据,故不列入。
  useEffect(() => {
    if (isOpen && mode !== 'view') {
      setValues(initialValues(resolveFields(columns, mode, exclude, props.fields), row))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, row, columns])

  const shown = visibleFields(fields, renderMode === 'view' ? ((renderRow ?? {}) as Record<string, unknown>) : values)
  const title = renderMode === 'create' ? `新增${label}` : renderMode === 'edit' ? `编辑${label}` : `${label}详情`

  // extraContent 第 4 参:把补丁并入表单草稿;view 态无草稿可改,no-op
  const patchValues = (patch: Record<string, unknown>) => {
    if (renderMode === 'view') return
    setValues((v) => ({ ...v, ...patch }))
  }

  const save = async () => {
    if (!props.onSubmit || mode === 'view') return
    const missing = missingRequired(fields, values, mode)
    if (missing.length > 0) {
      toast.danger(`请填写:${missing.join('、')}`)
      return
    }
    setSaving(true)
    try {
      await props.onSubmit(collectValues(fields, values, mode), mode)
      props.onOpenChange(false)
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className={contentClassName}>
          {/* 显式 aria-label:Heading slot 的 labelledby 在过渡期渲染中晚一拍,RAC 会刷
              "Dialog 必须有标题" 的误报警告;有 aria-label 则完全绕开该告警路径 */}
          <Sheet.Dialog className="h-full" aria-label={title}>
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {metaError || byId.isError ? (
                // GridMeta/rowId 取数失败:展示报错并可重试(与 SynieDataGrid 同一套失败态)。
                // 错误分支在 spinner 之前:meta 失败时 byId 因 enabled 门控永远 isPending,反序会卡死转圈
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>数据加载失败</EmptyState.Title>
                    <EmptyState.Description>
                      {((remoteMeta.error ?? byId.error) as Error).message}
                    </EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button variant="secondary" onPress={() => (metaError ? remoteMeta.refetch() : byId.refetch())}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : metaPending || rowPending ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : rowMissing ? (
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>记录不存在或无权查看</EmptyState.Title>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <>
                {/* 返回 null/undefined 不渲染占位容器(空 div 的 mb-6 会平白多出一段间距) */}
                {(() => {
                  const node = props.headerContent?.(renderMode, renderRow, values, patchValues)
                  return node == null ? null : <div className="mb-6">{node}</div>
                })()}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                  {shown.map((f) => (
                    <div key={f.name} className={COL_SPAN[f.cols]}>
                      {renderMode === 'view' ? (
                        <ViewField field={f} row={renderRow ?? ({ id: '' } as Row)} />
                      ) : (
                        <FieldInput
                          field={f}
                          row={renderRow}
                          value={values[f.name]}
                          values={values}
                          isDisabled={isFieldDisabled(f, renderMode) || saving}
                          onChange={(v) =>
                            setValues((prev) => ({ ...prev, [f.name]: v, ...(f.effects?.(v) ?? {}) }))
                          }
                          patchValues={patchValues}
                        />
                      )}
                    </div>
                  ))}
                  {props.extraContent && (
                    <div className="lg:col-span-12">
                      {props.extraContent(renderMode, renderRow, values, patchValues)}
                    </div>
                  )}
                </div>
                </>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              {mode === 'view' ? (
                <>
                  <Sheet.Close>
                    <Button variant="secondary">关闭</Button>
                  </Sheet.Close>
                  {props.footerActions?.(renderMode, renderRow)}
                  {props.onEdit && <Button onPress={props.onEdit}>编辑</Button>}
                </>
              ) : (
                <>
                  <Sheet.Close>
                    <Button variant="secondary" isDisabled={saving}>
                      取消
                    </Button>
                  </Sheet.Close>
                  {/* 元数据失败时字段集为空,禁止提交空 payload */}
                  <Button onPress={save} isPending={saving} isDisabled={metaError}>
                    {props.submitLabel ?? '保存'}
                  </Button>
                </>
              )}
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}

/** view 态字段:label + 与表格同一套格式化(cellText) */
function ViewField({ field, row }: { field: ResolvedField; row: Row }) {
  if (field.col.type === 'fk' && field.col.ref && !field.render) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{field.label}</span>
        <div className="text-sm">
          <FkLink col={field.col} row={row} />
        </div>
      </div>
    )
  }
  const value = row[field.name]
  const text = cellText(field.col, value, row)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{field.label}</span>
      <div className="text-sm">
        {field.render ? field.render(value, row) : text || <span className="text-muted">—</span>}
      </div>
    </div>
  )
}

/** 表单控件按列类型分发(filter-popover 先例);override.input 优先 */
function FieldInput({
  field,
  row,
  value,
  values,
  isDisabled,
  onChange,
  patchValues,
}: {
  field: ResolvedField
  row?: Row | null
  value: unknown
  values: Record<string, unknown>
  isDisabled: boolean
  onChange: (v: unknown) => void
  patchValues: (patch: Record<string, unknown>) => void
}) {
  if (field.input) return <>{field.input({ value, onChange, isDisabled, values, patchValues })}</>

  // fk 列:ref(权限裁剪后)或页面 remote.resource 提供数据源;都没有(含多态 fk,表单需页面
  // 按判别字段自定义 input,journals 先例)则落到 default TextField(fail-closed)
  if (field.col.type === 'fk') {
    const ref = field.col.ref
    const cfg = { resource: ref?.resource ?? undefined, labelField: ref?.labelField ?? undefined, ...field.remote }
    if (cfg.resource) {
      const rel = ref?.relation && row ? ((row[ref.relation] as Row | null | undefined) ?? null) : null
      const common = {
        ...(cfg as RemoteSourceConfig & { resource: string }),
        label: field.label,
        value: value == null || value === '' ? null : String(value),
        onChange: (id: string | null) => onChange(id),
        isDisabled,
        isRequired: field.required,
        placeholder: field.placeholder,
        initialRows: rel ? [rel] : undefined,
      }
      return field.picker === 'dialog' ? <RemoteDialogSelect {...common} /> : <RemoteSelect {...common} />
    }
  }

  switch (field.col.type) {
    case 'boolean':
      return (
        <Switch isSelected={Boolean(value)} onChange={onChange} isDisabled={isDisabled}>
          <Switch.Content className="text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            {field.label}
          </Switch.Content>
        </Switch>
      )
    case 'integer':
    case 'decimal':
      return (
        <NumberField
          fullWidth
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>{field.label}</Label>
          {/* 库样式 group 是 grid-cols-[40px_1fr_40px](给步进按钮留列);不渲染步进
              按钮时 input 会掉进 40px 列,改单列让 input 撑满 */}
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder={field.placeholder} />
          </NumberField.Group>
        </NumberField>
      )
    case 'date':
    case 'datetime':
      // datetime 到秒粒度(银行流水交易时间先例),CalendarDateTime.toString() 落草稿
      // YYYY-MM-DDTHH:mm:ss;date 保持日粒度 YYYY-MM-DD
      return (
        <DatePicker
          granularity={field.col.type === 'datetime' ? 'second' : 'day'}
          hourCycle={24}
          isDisabled={isDisabled}
          isRequired={field.required}
          value={field.col.type === 'datetime' ? safeParseDateTime(value) : safeParseDate(value)}
          onChange={(v) => onChange(v ? v.toString() : null)}
        >
          <Label>{field.label}</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label={field.label}>
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
              <Calendar.YearPickerGrid>
                <Calendar.YearPickerGridBody>
                  {({ year }) => <Calendar.YearPickerCell year={year} />}
                </Calendar.YearPickerGridBody>
              </Calendar.YearPickerGrid>
            </Calendar>
          </DatePicker.Popover>
        </DatePicker>
      )
    case 'enum':
      return (
        <Select
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null ? null : String(value)}
          onChange={(v) => onChange(v)}
        >
          <Label>{field.label}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {(field.col.enumOptions ?? []).map((o) => (
                <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )
    default:
      return (
        <TextField
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null ? '' : String(value)}
          onChange={onChange}
        >
          <Label>{field.label}</Label>
          <Input placeholder={field.placeholder} />
        </TextField>
      )
  }
}
