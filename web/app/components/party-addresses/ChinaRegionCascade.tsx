/**
 * 省 / 市 / 区三级级联（数据见 china-regions/pca-code.json）。
 * 写入表单字段 province / city / district；上级变更清空下级。
 */
import { Label, ListBox, Select } from '@heroui/react'
import {
  CHINA_PROVINCES,
  citiesOf,
  districtsOf,
} from '~/lib/china-regions'

export function ChinaRegionCascade(props: {
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  isDisabled: boolean
  required?: boolean
}) {
  const { values, patchValues, isDisabled, required = true } = props
  const province = str(values.province)
  const city = str(values.city)
  const district = str(values.district)

  const cities = citiesOf(province)
  const districts = districtsOf(province, city)

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <RegionSelect
        label="省/直辖市"
        placeholder="请选择省"
        value={province}
        options={CHINA_PROVINCES.map((p) => p.name)}
        isDisabled={isDisabled}
        required={required}
        onChange={(next) =>
          patchValues({
            province: next,
            city: null,
            district: null,
          })
        }
      />
      <RegionSelect
        label="市"
        placeholder={province ? '请选择市' : '先选省'}
        value={city}
        options={cities.map((c) => c.name)}
        isDisabled={isDisabled || !province}
        required={required}
        onChange={(next) =>
          patchValues({
            city: next,
            district: null,
          })
        }
      />
      <RegionSelect
        label="区/县"
        placeholder={city ? '请选择区/县' : '先选市'}
        value={district}
        options={districts.map((d) => d.name)}
        isDisabled={isDisabled || !city}
        required={required}
        onChange={(next) => patchValues({ district: next })}
      />
    </div>
  )
}

function RegionSelect(props: {
  label: string
  placeholder: string
  value: string | null
  options: string[]
  isDisabled: boolean
  required: boolean
  onChange: (v: string | null) => void
}) {
  return (
    <Select
      isDisabled={props.isDisabled}
      isRequired={props.required}
      value={props.value}
      onChange={(v) => props.onChange(v === '' || v == null ? null : String(v))}
    >
      <Label>{props.label}</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? props.placeholder : defaultChildren
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {props.options.map((name) => (
            <ListBox.Item key={name} id={name} textValue={name}>
              {name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function str(v: unknown): string | null {
  if (v == null || v === '') return null
  return String(v)
}
