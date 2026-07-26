import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Label, ListBox, Select } from '@heroui/react'
import { materialClient, materialUnitClient } from '~/lib/resources/inventory'

/**
 * 单据行的单位下拉:候选 = 选中物料的默认单位 + 其单位转换行单位,
 * 与后端 Sales.MaterialUnitAllowed 校验同源(前端做体验层)。
 * 销售订单条目与报价条目共用;未选物料时禁用并提示。
 */

interface UnitOption {
  id: string
  name: string
}

export function MaterialUnitSelect({
  materialId,
  value,
  onChange,
  isDisabled,
}: {
  materialId: string | null
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
}) {
  const query = useQuery({
    queryKey: ['materialUnitOptions', materialId],
    enabled: materialId != null,
    staleTime: 60_000,
    queryFn: () =>
      Promise.all([
        materialClient.get(materialId!),
        materialUnitClient.query({
          limit: 200,
          offset: 0,
          filter: { materialId: { kind: 'fk', op: 'in', values: [materialId!], labels: [] } },
        }),
      ]).then(([material, conversions]) => {
        const units = [
          (material?.defaultUnit as UnitOption | null | undefined) ?? null,
          ...conversions.results.map((row) => (row.unit as UnitOption | null | undefined) ?? null),
        ]
        // 默认单位与转换行不会重复(后端校验),仍按 id 去重兜底
        const seen = new Set<string>()
        return units.filter((u): u is UnitOption => u != null && !seen.has(u.id) && (seen.add(u.id), true))
      }),
  })
  const options = query.data ?? []

  // 选物料后默认带默认单位(options 首位即默认单位);用户已选(含编辑存量行)不覆盖
  useEffect(() => {
    if (value == null && options.length > 0) onChange(options[0].id)
  }, [value, options, onChange])

  return (
    <Select
      isDisabled={isDisabled || materialId == null}
      isRequired
      value={value == null || value === '' ? null : String(value)}
      onChange={(v) => onChange(v === '' ? null : v)}
    >
      <Label>单位</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? (materialId == null ? '先选物料' : '选择单位…') : defaultChildren
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((u) => (
            <ListBox.Item key={u.id} id={u.id} textValue={u.name}>
              {u.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
