import { Label, ListBox, Select } from '@heroui/react'

// 报销类型 = 科目角色的五个费用角色(bas_account_role 枚举,与后端 AccountRole.expense_roles/0 同序);
// 纯录入辅助:单据上不存角色值、只存科目(见 CONTEXT.md「费用角色」)
export const EXPENSE_ROLES = [
  { value: 'TRAVEL', label: '差旅费' },
  { value: 'OFFICE', label: '办公费' },
  { value: 'ENTERTAINMENT', label: '业务招待费' },
  { value: 'TRANSPORT', label: '交通费' },
  { value: 'OTHER_EXPENSE', label: '其他费用' },
] as const

export const expenseRoleLabel = (value: string) =>
  EXPENSE_ROLES.find((r) => r.value === value)?.label ?? value

// 「其他应付款」往来角色:费用报销发票的往来科目(员工报销挂账)挂此角色
export const OTHER_PAYABLE_ROLE = 'OTHER_PAYABLE'

/** 报销类型选择器:只产出角色值,带科目逻辑由调用方接 onChange 实现 */
export function ExpenseRoleSelect({
  value,
  onChange,
  isDisabled,
}: {
  value: string | null
  onChange: (role: string | null) => void
  isDisabled?: boolean
}) {
  return (
    <Select isDisabled={isDisabled} value={value} onChange={(v) => onChange(v === '' ? null : String(v))}>
      <Label>报销类型</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? '选择后自动带出科目…' : defaultChildren
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {EXPENSE_ROLES.map((r) => (
            <ListBox.Item key={r.value} id={r.value} textValue={r.label}>
              {r.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
