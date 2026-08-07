/**
 * 会计科目 Presentation Extension：动态 role 可见性与 isGroup effects。
 */
import { requireWriter } from '../catalog/require-writer'
import type { ResourceBinding } from '../catalog/types'
import type { PresentationExtension } from './types'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState } from '~/components/synie-data-grid/types'

export const ACCOUNT_RESOURCE = 'basAccounts'

export function createAccountPresentation(
  binding: ResourceBinding,
  options?: { companyId?: string | null; companyFilter?: FilterState },
): PresentationExtension {
  if (binding.resource !== ACCOUNT_RESOURCE) {
    throw new Error(
      `科目 Presentation Extension 需要 resource=basAccounts，收到 ${binding.resource}`,
    )
  }

  const fields: Record<string, FieldOverride> = {
    code: { required: true, edit: 'createOnly', cols: 6, placeholder: '如 1001' },
    name: { required: true, cols: 6, placeholder: '如 库存现金' },
    direction: { required: true, cols: 6 },
    isGroup: {
      cols: 6,
      defaultValue: false,
      effects: (value) => (value === true ? { role: null } : undefined),
    },
    currencyId: {
      cols: 6,
      label: '币种',
      remote: {
        filterState: { active: { kind: 'bool', eq: true } },
      },
    },
    role: { cols: 6, visible: (values) => values.isGroup !== true },
    parentId: {
      cols: 6,
      label: '上级科目',
      remote: {
        filterState: options?.companyFilter,
      },
    },
    companyId: { visible: () => false },
    childrenCount: { visible: () => false },
  }

  return {
    resource: ACCOUNT_RESOURCE,
    kind: 'extension',
    label: '科目',
    exclude: ['active', 'id', 'insertedAt', 'updatedAt', 'hasChildren'],
    fields,
    binding,
  }
}

export async function submitAccountForm(
  presentation: PresentationExtension,
  values: Record<string, unknown>,
  mode: 'create' | 'edit' | 'view',
  rowId: string | undefined,
  companyId: string | null,
): Promise<void> {
  if (mode === 'view') throw new Error('查看模式不可提交')
  const input = values.isGroup === true ? { ...values, role: null } : values
  if (mode === 'create') {
    await requireWriter(presentation.binding, 'create', '科目')({ ...input, companyId })
    return
  }
  if (!rowId) throw new Error('更新科目缺少 id')
  await requireWriter(presentation.binding, 'update', '科目')(rowId, input)
}
