import { useMemo, useState } from 'react'
import { Button, Chip, CloseButton, Input, Label, ListBox, NumberField, Select, TextField } from '@heroui/react'
import { useGridMeta } from '../synie-data-grid/meta'

/** 编号段(与后端 sys_numbering_rule.segments 一致;label 为展示冗余,后端忽略) */
export interface NumberSegment {
  type: 'text' | 'field' | 'seq'
  value?: string
  field?: string
  label?: string
  format?: string
  /** 0=不补零,1..12 补零宽度 */
  padding?: number
}

const DATE_FORMATS = [
  { value: 'YYYYMM', label: '年月(202607)' },
  { value: 'YYYY', label: '年(2026)' },
  { value: 'YYYYMMDD', label: '年月日(20260710)' },
  { value: 'YYMM', label: '短年月(2607)' },
  { value: 'YY', label: '短年(26)' },
  { value: 'MM', label: '月(07)' },
  { value: 'DD', label: '日(10)' },
]

const SKIP = ['id', 'insertedAt', 'updatedAt']

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

function dateSample(format: string): string {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return format.replace('YYYY', yyyy).replace('YY', yyyy.slice(2)).replace('MM', mm).replace('DD', dd)
}

export function segmentLabel(seg: NumberSegment): string {
  if (seg.type === 'text') return `“${seg.value ?? ''}”`
  if (seg.type === 'seq') {
    const p = seg.padding ?? 4
    return p === 0 ? '序号(不补零)' : `序号(${p}位)`
  }
  return (seg.label ?? seg.field ?? '') + (seg.format ? `·${seg.format}` : '')
}

/**
 * 示例串(非真实取号):日期段用今天渲染,序号按 padding 取 1,
 * 其他字段用中文 label 占位;无 label 时回退字段路径。
 * 真号由后端按 field 路径解析记录值,与 label 无关。
 */
export function segmentsPreview(segments: NumberSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return seg.value ?? ''
      if (seg.type === 'seq') {
        const p = seg.padding ?? 4
        return p === 0 ? '1' : '1'.padStart(p, '0')
      }
      if (seg.format) return dateSample(seg.format)
      // 优先中文 label;无 label 时用尖括号标出路径,避免被误当成真实编号
      const name = seg.label || seg.field || '?'
      return `<${name}>`
    })
    .join('')
}

export interface SegmentsEditorProps {
  /** 绑定资源的表格资源名(numberableResources.grid),未选资源时传 null */
  grid: string | null
  value: NumberSegment[]
  onChange: (segments: NumberSegment[]) => void
  isDisabled?: boolean
}

/** 编号段组装器:固定文本 / 资源字段(fk 二级字段、日期带格式)/ 序号(仅一个),点选拼装;支持拖拽排序 */
export function SegmentsEditor({ grid, value, onChange, isDisabled }: SegmentsEditorProps) {
  const meta = useGridMeta(grid ?? '', grid != null)

  const [text, setText] = useState('')
  const [fieldName, setFieldName] = useState<string | null>(null)
  const [subField, setSubField] = useState<string | null>(null)
  const [format, setFormat] = useState<string>('YYYYMM')
  const [padding, setPadding] = useState(4)
  const [dragFrom, setDragFrom] = useState<number | null>(null)

  const columns = useMemo(
    () => (meta.data?.columns ?? []).filter((c) => !SKIP.includes(c.name)),
    [meta.data]
  )
  const col = columns.find((c) => c.name === fieldName) ?? null
  // 段路径按 relation.field 拼、候选按 ref.resource 查,多态 fk 两者皆无,按普通字段处理
  const isFk = col?.type === 'fk' && col.ref?.relation != null && col.ref.resource != null

  // fk 字段的目标资源一级字段候选(gridMeta 反射;剔系统列与更深层 fk)
  const subMeta = useGridMeta(col?.ref?.resource ?? '', isFk)
  const subColumns = useMemo(
    () => (subMeta.data?.columns ?? []).filter((c) => !SKIP.includes(c.name) && c.type !== 'fk'),
    [subMeta.data]
  )
  const subCol = subColumns.find((c) => c.name === subField) ?? null

  const dateChosen = isFk
    ? subCol?.type === 'date' || subCol?.type === 'datetime'
    : col?.type === 'date' || col?.type === 'datetime'
  const hasSeq = value.some((s) => s.type === 'seq')

  const addField = () => {
    if (!col || (isFk && !subCol)) return
    const seg: NumberSegment =
      isFk && col.ref?.relation && subCol
        ? {
            type: 'field',
            field: `${snake(col.ref.relation)}.${snake(subCol.name)}`,
            label: `${col.label}·${subCol.label}`,
          }
        : { type: 'field', field: snake(col.name), label: col.label }
    if (dateChosen) seg.format = format
    onChange([...value, seg])
    setFieldName(null)
    setSubField(null)
  }

  const moveSegment = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= value.length || to >= value.length) return
    const next = value.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }

  if (grid == null) {
    return (
      <div className="flex flex-col gap-1">
        <Label>编号段</Label>
        <p className="text-sm text-muted">请先选择绑定资源</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>编号段{isDisabled ? '' : '*'}</Label>

      {/* 已选段:可拖拽排序 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 && <span className="text-sm text-muted">暂无编号段,请在下方添加</span>}
        {value.map((seg, i) => (
          <span
            key={`${i}-${seg.type}-${seg.field ?? seg.value ?? seg.padding}`}
            draggable={!isDisabled}
            className={isDisabled ? undefined : 'cursor-grab active:cursor-grabbing'}
            onDragStart={(e) => {
              setDragFrom(i)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(i))
            }}
            onDragOver={(e) => {
              if (isDisabled) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'))
              moveSegment(from, i)
              setDragFrom(null)
            }}
            onDragEnd={() => setDragFrom(null)}
          >
            <Chip size="sm" className={isDisabled ? undefined : 'pr-1'} color={seg.type === 'seq' ? 'accent' : 'default'}>
              <Chip.Label>{segmentLabel(seg)}</Chip.Label>
              {!isDisabled && (
                <CloseButton
                  aria-label={`删除段 ${segmentLabel(seg)}`}
                  className="h-4 w-4 [&_svg]:size-3"
                  onPress={() => onChange(value.filter((_, j) => j !== i))}
                />
              )}
            </Chip>
          </span>
        ))}
      </div>

      {value.length > 0 && (
        <p className="text-xs text-muted">
          示例:<span className="font-mono">{segmentsPreview(value)}</span>
          {!isDisabled && <span className="ml-2">（可拖拽段调整顺序）</span>}
        </p>
      )}

      {!isDisabled && (
        <div className="flex flex-col gap-2 rounded-lg border border-separator p-3">
          {/* 固定文本 */}
          <div className="flex items-end gap-2">
            <TextField className="flex-1" value={text} onChange={setText} aria-label="固定文本">
              <Input placeholder="固定文本,如 记 或 -" />
            </TextField>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={text === ''}
              onPress={() => {
                onChange([...value, { type: 'text', value: text }])
                setText('')
              }}
            >
              加文本
            </Button>
          </div>

          {/* 字段(fk 二级、日期格式) */}
          <div className="flex items-end gap-2">
            <Select
              className="flex-1"
              aria-label="字段"
              placeholder="选择字段…"
              value={fieldName}
              onChange={(v) => {
                setFieldName(v == null ? null : String(v))
                setSubField(null)
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {columns.map((c) => (
                    <ListBox.Item key={c.name} id={c.name} textValue={c.label}>
                      {c.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            {isFk && (
              <Select
                className="flex-1"
                aria-label="外键字段"
                placeholder={`${col?.label ?? ''}的字段…`}
                value={subField}
                onChange={(v) => setSubField(v == null ? null : String(v))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {subColumns.map((c) => (
                      <ListBox.Item key={c.name} id={c.name} textValue={c.label}>
                        {c.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
            {dateChosen && (
              <Select
                className="w-44"
                aria-label="日期格式"
                value={format}
                onChange={(v) => setFormat(v == null ? 'YYYYMM' : String(v))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {DATE_FORMATS.map((f) => (
                      <ListBox.Item key={f.value} id={f.value} textValue={f.label}>
                        {f.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
            <Button size="sm" variant="secondary" isDisabled={!col || (isFk && !subCol)} onPress={addField}>
              加字段
            </Button>
          </div>

          {/* 序号:0=不补零,1..12 补零位数 */}
          <div className="flex items-end gap-2">
            <NumberField
              className="flex-1"
              aria-label="序号位数"
              minValue={0}
              maxValue={12}
              value={padding}
              onChange={(n) => setPadding(Number.isFinite(n) ? n : 4)}
              isDisabled={hasSeq}
            >
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input placeholder="序号位数,0=不补零" />
              </NumberField.Group>
            </NumberField>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={hasSeq}
              onPress={() => onChange([...value, { type: 'seq', padding }])}
            >
              {hasSeq ? '已有序号段' : '加序号'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
