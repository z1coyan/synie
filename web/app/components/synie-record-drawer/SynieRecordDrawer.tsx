import { useEffect, useState } from 'react'
import { parseDate } from '@internationalized/date'
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
import { Sheet } from '@heroui-pro/react'
import { cellText } from '../synie-data-grid/format'
import { useGridMeta } from '../synie-data-grid/meta'
import type { Row } from '../synie-data-grid/types'
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
  // ponytail: 详情需要表格未取字段时再加 by-id 查询
  row?: Row | null
  exclude?: string[]
  fields?: Record<string, FieldOverride>
  /** create/edit 提交;resolve 即成功(组件关抽屉),throw 则 toast 且不关 */
  onSubmit?: (values: Record<string, unknown>, mode: 'create' | 'edit') => Promise<void>
  /** view 态 footer 显示「编辑」按钮,点击回调(页面自行切 mode) */
  onEdit?: () => void
  /** Sheet.Content 宽度样式 */
  contentClassName?: string
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

export function SynieRecordDrawer(props: SynieRecordDrawerProps) {
  const { resource, mode, isOpen, row, exclude, label = '', contentClassName = 'w-full lg:w-[480px]' } = props
  const meta = useGridMeta(resource)

  const fields = resolveFields(meta.data?.columns ?? [], mode, exclude, props.fields)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  // 打开/换行/换模式时重建草稿(view 不用草稿,直接读 row)。
  // props.fields/exclude 常为内联字面量,进依赖会在父级每次渲染时重置用户输入;
  // 初值只取决于列类型与行数据,故不列入。
  useEffect(() => {
    if (isOpen && mode !== 'view') {
      setValues(initialValues(resolveFields(meta.data?.columns ?? [], mode, exclude, props.fields), row))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, row, meta.data])

  const shown = visibleFields(fields, mode === 'view' ? ((row ?? {}) as Record<string, unknown>) : values)
  const title = mode === 'create' ? `新增${label}` : mode === 'edit' ? `编辑${label}` : `${label}详情`

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
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {meta.isPending ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                  {shown.map((f) => (
                    <div key={f.name} className={COL_SPAN[f.cols]}>
                      {mode === 'view' ? (
                        <ViewField field={f} row={row ?? ({ id: '' } as Row)} />
                      ) : (
                        <FieldInput
                          field={f}
                          value={values[f.name]}
                          isDisabled={isFieldDisabled(f, mode) || saving}
                          onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              {mode === 'view' ? (
                <>
                  <Sheet.Close>
                    <Button variant="secondary">关闭</Button>
                  </Sheet.Close>
                  {props.onEdit && <Button onPress={props.onEdit}>编辑</Button>}
                </>
              ) : (
                <>
                  <Sheet.Close>
                    <Button variant="secondary" isDisabled={saving}>
                      取消
                    </Button>
                  </Sheet.Close>
                  <Button onPress={save} isPending={saving}>
                    保存
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
  const value = row[field.name]
  const text = cellText(field.col, value)
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
  value,
  isDisabled,
  onChange,
}: {
  field: ResolvedField
  value: unknown
  isDisabled: boolean
  onChange: (v: unknown) => void
}) {
  if (field.input) return <>{field.input({ value, onChange, isDisabled })}</>

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
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>{field.label}</Label>
          <NumberField.Group>
            <NumberField.Input placeholder={field.placeholder} />
          </NumberField.Group>
        </NumberField>
      )
    case 'date':
    case 'datetime':
      // ponytail: datetime 编辑先按日期粒度,业务需要时分秒时换带 granularity 的 DateField
      return (
        <DatePicker
          isDisabled={isDisabled}
          isRequired={field.required}
          value={typeof value === 'string' && value ? parseDate(value) : null}
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
