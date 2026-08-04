/**
 * 物料 Presentation Extension：字段/effects/tabs 静态面。
 * 附件与单位转换 tab 内容由页面经 extraContent / tabExtraContent 组合（业务状态在页面）。
 */
import type { ResourceBinding } from '../catalog/types'
import type { PresentationExtension } from './types'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'

export const MATERIAL_RESOURCE = 'invMaterials'

export interface MaterialPresentation extends PresentationExtension {
  contentClassName: string
  tabs: Array<{ key: string; label: string }>
}

export function createMaterialPresentation(
  binding: ResourceBinding,
): MaterialPresentation {
  if (binding.resource !== MATERIAL_RESOURCE) {
    throw new Error(
      `物料 Presentation Extension 需要 resource=invMaterials，收到 ${binding.resource}`,
    )
  }

  const fields: Record<string, FieldOverride> = {
    code: {
      order: 0,
      cols: 6,
      section: '基本信息',
      edit: 'readOnly',
      placeholder: '保存后自动编号(分类号[客户号]-序号)',
    },
    materialType: { order: 1, cols: 6, required: true, defaultValue: 'STOCK' },
    categoryId: {
      order: 2,
      cols: 6,
      required: true,
      remote: {
        filterState: {
          isLeaf: { kind: 'bool', eq: true },
          active: { kind: 'bool', eq: true },
        },
      },
    },
    name: { order: 3, cols: 6, required: true },
    spec: { order: 4, cols: 6, placeholder: '如 M8×30' },
    isCustomerMaterial: {
      order: 5,
      cols: 6,
      section: '客户物料',
      defaultValue: false,
      effects: (v) => (v ? {} : { customerId: null, customerPartNo: null }),
    },
    customerId: {
      order: 6,
      cols: 6,
      section: '客户物料',
      visible: (values) => values.isCustomerMaterial === true,
    },
    customerPartNo: {
      order: 7,
      cols: 6,
      section: '客户物料',
      visible: (values) => values.isCustomerMaterial === true,
    },
    defaultUnitId: { order: 8, cols: 6, required: true, section: '基本信息' },
  }

  return {
    resource: MATERIAL_RESOURCE,
    kind: 'extension',
    label: '物料',
    exclude: ['active'],
    fields,
    binding,
    contentClassName: 'w-full lg:w-[640px]',
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'units', label: '单位转换' },
    ],
  }
}

export async function submitMaterialForm(
  presentation: PresentationExtension,
  values: Record<string, unknown>,
  mode: 'create' | 'edit' | 'view',
  rowId: string | undefined,
): Promise<string> {
  if (mode === 'view') throw new Error('查看模式不可提交')
  const writer = presentation.binding.writer
  if (!writer) throw new Error('物料不支持写入')
  if (mode === 'create') {
    if (!('create' in writer) || !writer.create) throw new Error('物料不支持 create')
    const saved = await writer.create(values)
    return String(saved.id)
  }
  if (!rowId) throw new Error('更新物料缺少 id')
  if (!('update' in writer) || !writer.update) throw new Error('物料不支持 update')
  const saved = await writer.update(rowId, values)
  return String(saved.id)
}
