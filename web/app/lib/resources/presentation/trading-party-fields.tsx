import { Label, ListBox, Select } from '@heroui/react'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'

interface TradingPartyFieldOptions {
  kind: 'sales' | 'purchase'
  typeOrder: number
  idOrder: number
  idLabel?: string
  resetOnType?: Record<string, unknown>
  resetOnParty?: Record<string, unknown>
}

/**
 * 购销单据共享的多态对手呈现。
 * 销售只允许客户/内部公司；采购只允许供应商/内部公司。
 */
export function tradingPartyFields({
  kind,
  typeOrder,
  idOrder,
  idLabel = '对手',
  resetOnType,
  resetOnParty,
}: TradingPartyFieldOptions): {
  partyType: FieldOverride
  partyId: FieldOverride
} {
  const externalType = kind === 'sales' ? 'CUSTOMER' : 'SUPPLIER'
  const externalLabel = kind === 'sales' ? '客户' : '供应商'
  const externalResource = kind === 'sales' ? 'salCustomers' : 'purSuppliers'

  return {
    partyType: {
      order: typeOrder,
      cols: 6,
      required: true,
      label: '对手类型',
      effects: () => ({ partyId: null, ...resetOnType }),
      input: ({ value, onChange, isDisabled }) => (
        <Select
          isDisabled={isDisabled}
          isRequired
          value={value == null || value === '' ? null : String(value)}
          onChange={(next) => onChange(next === '' ? null : next)}
        >
          <Label>对手类型</Label>
          <Select.Trigger>
            <Select.Value>
              {({ isPlaceholder, defaultChildren }) =>
                isPlaceholder ? '请选择…' : defaultChildren
              }
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item
                key={externalType}
                id={externalType}
                textValue={externalLabel}
              >
                {externalLabel}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                内部公司
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      ),
    },
    partyId: {
      order: idOrder,
      cols: 6,
      required: true,
      label: idLabel,
      visible: (values) =>
        values.partyType === externalType || values.partyType === 'COMPANY',
      ...(resetOnParty ? { effects: () => ({ ...resetOnParty }) } : {}),
      input: ({ value, onChange, isDisabled, values }) => {
        const isCompany = values.partyType === 'COMPANY'
        return (
          <RemoteSelect
            resource={isCompany ? 'basCompanies' : externalResource}
            label={idLabel}
            placeholder={isCompany ? '选择内部公司…' : `选择${externalLabel}…`}
            value={value == null ? null : String(value)}
            onChange={(id) => onChange(id)}
            isDisabled={isDisabled}
          />
        )
      },
    },
  }
}
