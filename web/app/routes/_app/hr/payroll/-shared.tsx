import { Label, ListBox, Select } from '@heroui/react'

// 近 24 个月候选(照考勤月汇总先例;薪资数据从上线月起,更早无意义)
export function monthOptions(): { value: string; label: string }[] {
  const now = new Date()
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { value, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` }
  })
}

export function MonthSelect(props: { value: string; onChange: (v: string) => void }) {
  const options = monthOptions()

  return (
    <Select
      className="w-full lg:w-44"
      value={props.value}
      onChange={(v) => v != null && props.onChange(String(v))}
      aria-label="选择月份"
    >
      <Label>月份</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

// 枚举值(GraphQL 大写)→ 中文;发放类型与工资单状态两组共用此形态
export const PAYMENT_KIND_LABELS: Record<string, string> = {
  NORMAL: '发放',
  SUPPLEMENT: '补发',
}
