import { useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { parseDate } from '@internationalized/date'
import {
  Button,
  Calendar,
  Checkbox,
  DateField,
  DatePicker,
  DateRangePicker,
  Input,
  ListBox,
  NumberField,
  Popover,
  RangeCalendar,
  Select,
  Switch,
} from '@heroui/react'
import { RemoteMultiSelect } from '../synie-remote-select/RemoteMultiSelect'
import type { ColumnFilter, DateOp, GridColumnMeta, GridColumnRef, NumberOp, TextOp } from './types'
import { useDraft } from './use-debounced'

// 弹层 DOM 上 portal 到了表格外,但 React 合成事件仍沿组件树冒泡回可排序的 <th>:
// 表格的 usePress/键盘导航会拦截指针与方向键,导致输入框无法划选、焦点被抢。
// 在 Dialog 层截断冒泡;Escape 放行给上层 Popover 做关闭。
const stopBubble = {
  onKeyDown: (e: KeyboardEvent) => e.key !== 'Escape' && e.stopPropagation(),
  onKeyUp: (e: KeyboardEvent) => e.key !== 'Escape' && e.stopPropagation(),
  onPointerDown: (e: PointerEvent) => e.stopPropagation(),
  onPointerUp: (e: PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: MouseEvent) => e.stopPropagation(),
  onClick: (e: MouseEvent) => e.stopPropagation(),
}

const TEXT_OPS: [TextOp, string][] = [
  ['contains', '包含'],
  ['notContains', '不包含'],
  ['eq', '等于'],
  ['notEq', '不等于'],
]
const NUMBER_OPS: [NumberOp | 'between', string][] = [
  ['eq', '等于'],
  ['gt', '大于'],
  ['lt', '小于'],
  ['gte', '大于等于'],
  ['lte', '小于等于'],
  ['between', '区间'],
]
const DATE_OPS: [DateOp | 'between', string][] = [
  ['eq', '等于'],
  ['before', '之前'],
  ['after', '之后'],
  ['between', '区间'],
]

const TEXT_OP_LABEL: Record<TextOp, string> = { contains: '包含', notContains: '不包含', eq: '=', notEq: '≠' }
const NUMBER_OP_LABEL: Record<NumberOp, string> = { eq: '=', gt: '>', lt: '<', gte: '≥', lte: '≤' }
const DATE_OP_LABEL: Record<DateOp, string> = { eq: '', before: '早于', after: '晚于' }

/** 活跃筛选 Chip 的摘要文案,如「包含 采购」「≥ 10」「2026-01-01 ~ 2026-01-31」 */
export function filterSummary(col: GridColumnMeta, f: ColumnFilter): string {
  switch (f.kind) {
    case 'text':
      return `${TEXT_OP_LABEL[f.op]} ${f.value}`
    case 'bool':
      return f.eq ? '是' : '否'
    case 'enum':
      return (col.enumOptions ?? [])
        .filter((o) => f.values.includes(o.value))
        .map((o) => o.label)
        .join('、')
    case 'number':
      return f.op === 'between' ? `${f.gte ?? ''} ~ ${f.lte ?? ''}` : `${NUMBER_OP_LABEL[f.op]} ${f.value}`
    case 'date':
      return f.op === 'between' ? `${f.gte ?? ''} ~ ${f.lte ?? ''}` : `${DATE_OP_LABEL[f.op]} ${f.value}`.trim()
    case 'fk':
      return f.labels.join('、')
  }
}

/** 列头筛选按钮:绝对定位吸在表头单元格右缘(th 自带 relative),不随列对齐方式移动 */
export function ColumnFilterButton({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const active = filter !== undefined

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`筛选 ${column.label}`}
        className={`absolute end-1 top-1/2 h-6 w-6 min-w-6 -translate-y-1/2 ${active ? 'text-accent' : 'text-muted'}`}
      >
        <FilterIcon />
      </Button>
      <Popover.Content placement="bottom" className="w-72">
        <Popover.Dialog className="flex flex-col gap-3 p-3" {...stopBubble}>
          <Popover.Heading className="text-sm font-medium">{column.label}</Popover.Heading>
          <FilterControl column={column} filter={filter} onChange={onChange} />
          {active && (
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => {
                onChange(null)
                setIsOpen(false)
              }}
            >
              清除筛选
            </Button>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function FilterControl({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  switch (column.type) {
    case 'boolean':
      return (
        <Switch
          isSelected={filter?.kind === 'bool' ? filter.eq : false}
          onChange={(selected) => onChange({ kind: 'bool', eq: selected })}
        >
          <Switch.Content className="text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            仅看「是」
          </Switch.Content>
        </Switch>
      )
    case 'enum':
      return (
        <div className="flex flex-col gap-1">
          {(column.enumOptions ?? []).map((o) => {
            const values = filter?.kind === 'enum' ? filter.values : []
            const checked = values.includes(o.value)
            return (
              <Checkbox
                key={o.value}
                // 弹层 DOM 已 portal 但 React 上下文仍在表格树内,Table 的 CheckboxContext
                // 只认 slot="selection";slot={null} 退出该上下文,否则渲染即抛错
                slot={null}
                isSelected={checked}
                onChange={(sel) => {
                  const next = sel ? [...values, o.value] : values.filter((v) => v !== o.value)
                  onChange(next.length > 0 ? { kind: 'enum', values: next } : null)
                }}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {o.label}
                </Checkbox.Content>
              </Checkbox>
            )
          })}
        </div>
      )
    case 'fk':
      // ref 为 null 时后端已标 filterable=false,不会走到这里;防御性放空
      return column.ref ? (
        <FkFilter colRef={column.ref} filter={filter?.kind === 'fk' ? filter : undefined} onChange={onChange} />
      ) : null
    case 'integer':
    case 'decimal':
      return <NumberFilter filter={filter?.kind === 'number' ? filter : undefined} onChange={onChange} />
    case 'date':
    case 'datetime':
      return <DateFilter filter={filter?.kind === 'date' ? filter : undefined} onChange={onChange} />
    default:
      return <TextFilter filter={filter?.kind === 'text' ? filter : undefined} onChange={onChange} />
  }
}

/** 操作符下拉:弹层内嵌表单控件按设计规范用 secondary 变体 */
function OpSelect<K extends string>({
  value,
  options,
  onChange,
}: {
  value: K
  options: [K, string][]
  onChange: (v: K) => void
}) {
  return (
    <Select aria-label="筛选方式" variant="secondary" value={value} onChange={(v) => v != null && onChange(v as K)}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map(([k, label]) => (
            <ListBox.Item key={k} id={k} textValue={label}>
              {label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function FkFilter({
  colRef,
  filter,
  onChange,
}: {
  colRef: GridColumnRef
  filter: Extract<ColumnFilter, { kind: 'fk' }> | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  return (
    <RemoteMultiSelect
      resource={colRef.resource}
      labelField={colRef.labelField}
      value={filter?.values ?? []}
      placeholder="选择筛选值…"
      onChange={(ids, rows) => {
        if (ids.length === 0) return onChange(null)
        const byId = new Map(rows.map((r) => [r.id, r]))
        onChange({
          kind: 'fk',
          values: ids,
          labels: ids.map((id) => {
            const r = byId.get(id)
            return r && r[colRef.labelField] != null ? String(r[colRef.labelField]) : id.slice(0, 8)
          }),
        })
      }}
    />
  )
}

function TextFilter({
  filter,
  onChange,
}: {
  filter: Extract<ColumnFilter, { kind: 'text' }> | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  // 操作符本身不构成筛选,值为空时不发请求;弹层关闭即卸载,重开时从 filter 回填
  const [op, setOp] = useState<TextOp>(filter?.op ?? 'contains')
  const emit = (o: TextOp, v: string) => onChange(v ? { kind: 'text', op: o, value: v } : null)
  // 草稿即时回显,停稳才提交:打字期间不重渲染整表
  const [draft, setDraft] = useDraft(filter?.value ?? '', (v) => emit(op, v))
  return (
    <div className="flex flex-col gap-2">
      <OpSelect
        value={op}
        options={TEXT_OPS}
        onChange={(o) => {
          setOp(o)
          emit(o, draft)
        }}
      />
      <Input placeholder="筛选值…" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </div>
  )
}

function NumberFilter({
  filter,
  onChange,
}: {
  filter: Extract<ColumnFilter, { kind: 'number' }> | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  const [op, setOp] = useState<NumberOp | 'between'>(filter?.op ?? 'eq')
  const single = filter && filter.op !== 'between' ? filter.value : ''
  const range = filter?.op === 'between' ? filter : undefined

  const emitSingle = (o: NumberOp, v: string) => onChange(v ? { kind: 'number', op: o, value: v } : null)
  const emitRange = (patch: { gte?: string; lte?: string }) => {
    const next = { gte: range?.gte, lte: range?.lte, ...patch }
    onChange(next.gte || next.lte ? { kind: 'number', op: 'between', gte: next.gte, lte: next.lte } : null)
  }

  // 三个草稿都无条件声明(hooks 顺序);commit 里再按当前 op 门控,防止切换操作符后旧草稿停稳误提交
  const [draftSingle, setDraftSingle] = useDraft(single, (v) => {
    if (op !== 'between') emitSingle(op, v)
  })
  const [draftGte, setDraftGte] = useDraft(range?.gte ?? '', (v) => {
    if (op === 'between') emitRange({ gte: v || undefined })
  })
  const [draftLte, setDraftLte] = useDraft(range?.lte ?? '', (v) => {
    if (op === 'between') emitRange({ lte: v || undefined })
  })

  const numberInput = (value: string, onValue: (v: string) => void, label: string) => (
    <NumberField
      aria-label={label}
      variant="secondary"
      value={value === '' ? NaN : Number(value)}
      onChange={(n) => onValue(Number.isFinite(n) ? String(n) : '')}
    >
      {/* 无步进按钮:改单列,防 input 掉进库样式预留的 40px 按钮列(SynieRecordDrawer 同) */}
      <NumberField.Group className="grid-cols-[1fr]">
        <NumberField.Input placeholder={label} />
      </NumberField.Group>
    </NumberField>
  )

  return (
    <div className="flex flex-col gap-2">
      <OpSelect
        value={op}
        options={NUMBER_OPS}
        onChange={(o) => {
          setOp(o)
          // 单值↔区间字段形状不同,值带不过去:切到区间保留已有区间,否则清空等新值
          if (o === 'between') onChange(range ? { kind: 'number', op: 'between', gte: range.gte, lte: range.lte } : null)
          else emitSingle(o, draftSingle)
        }}
      />
      {op === 'between' ? (
        <div className="flex items-center gap-2">
          {numberInput(draftGte, setDraftGte, '起')}
          <span className="text-muted">~</span>
          {numberInput(draftLte, setDraftLte, '止')}
        </div>
      ) : (
        numberInput(draftSingle, setDraftSingle, '筛选值')
      )}
    </div>
  )
}

function DateFilter({
  filter,
  onChange,
}: {
  filter: Extract<ColumnFilter, { kind: 'date' }> | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  const [op, setOp] = useState<DateOp | 'between'>(filter?.op ?? 'eq')
  const single = filter && filter.op !== 'between' && filter.value ? parseDate(filter.value) : null
  const range =
    filter?.op === 'between' && filter.gte && filter.lte
      ? { start: parseDate(filter.gte), end: parseDate(filter.lte) }
      : null

  return (
    <div className="flex flex-col gap-2">
      <OpSelect
        value={op}
        options={DATE_OPS}
        onChange={(o) => {
          setOp(o)
          if (o === 'between') onChange(filter?.op === 'between' ? filter : null)
          else onChange(single ? { kind: 'date', op: o, value: single.toString() } : null)
        }}
      />
      {op === 'between' ? (
        <DateRangePicker
          aria-label="日期区间"
          value={range}
          onChange={(r) =>
            onChange(r ? { kind: 'date', op: 'between', gte: r.start.toString(), lte: r.end.toString() } : null)
          }
        >
          <DateField.Group fullWidth variant="secondary">
            <DateField.Input slot="start">{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateRangePicker.RangeSeparator />
            <DateField.Input slot="end">{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DateRangePicker.Trigger>
                <DateRangePicker.TriggerIndicator />
              </DateRangePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DateRangePicker.Popover>
            <RangeCalendar aria-label="日期区间">
              <RangeCalendar.Header>
                <RangeCalendar.YearPickerTrigger>
                  <RangeCalendar.YearPickerTriggerHeading />
                  <RangeCalendar.YearPickerTriggerIndicator />
                </RangeCalendar.YearPickerTrigger>
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </RangeCalendar.Header>
              <RangeCalendar.Grid>
                <RangeCalendar.GridHeader>
                  {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
                </RangeCalendar.GridHeader>
                <RangeCalendar.GridBody>{(date) => <RangeCalendar.Cell date={date} />}</RangeCalendar.GridBody>
              </RangeCalendar.Grid>
              <RangeCalendar.YearPickerGrid>
                <RangeCalendar.YearPickerGridBody>
                  {({ year }) => <RangeCalendar.YearPickerCell year={year} />}
                </RangeCalendar.YearPickerGridBody>
              </RangeCalendar.YearPickerGrid>
            </RangeCalendar>
          </DateRangePicker.Popover>
        </DateRangePicker>
      ) : (
        <DatePicker
          aria-label="日期"
          value={single}
          onChange={(v) => onChange(v ? { kind: 'date', op: op as DateOp, value: v.toString() } : null)}
        >
          <DateField.Group fullWidth variant="secondary">
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label="日期">
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
      )}
    </div>
  )
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M1.5 3h13l-5 6v4.5l-3-1.5V9l-5-6z" />
    </svg>
  )
}
