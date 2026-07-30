/**
 * 客户 Presentation Extension：完整 form controller + 附件面板。
 * create/edit/view 能力保持与迁移前等价；附件不进 FormMeta。
 */
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import type { ResourceBinding } from '../catalog/types'
import type { PresentationExtension } from './types'

export const CUSTOMER_RESOURCE = 'salCustomers'

/**
 * 由 salCustomers binding 构造；不得在内部再次解析 transport / binding。
 */
export function createCustomerPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  if (binding.resource !== CUSTOMER_RESOURCE) {
    throw new Error(
      `客户 Presentation Extension 需要 resource=salCustomers，收到 ${binding.resource}`,
    )
  }
  return {
    resource: CUSTOMER_RESOURCE,
    kind: 'extension',
    label: '客户',
    exclude: ['id', 'insertedAt', 'updatedAt'],
    fields: {
      code: { required: true, placeholder: '如 C0001' },
      name: { required: true, placeholder: '客户全称' },
      shortName: { placeholder: '如 华为' },
    },
    binding,
    extraContent: (mode, row) => (
      <SynieAttachmentPanel
        ownerType="sal_customer"
        ownerId={row?.id as string | undefined}
        readonly={mode === 'view'}
      />
    ),
  }
}

/** 经 binding.writer 提交客户主数据（codec 仅透传标量） */
export async function submitCustomerForm(
  presentation: PresentationExtension,
  values: Record<string, unknown>,
  mode: 'create' | 'edit' | 'view',
  rowId: string | undefined,
): Promise<string> {
  if (mode === 'view') throw new Error('查看模式不可提交')
  const writer = presentation.binding.writer
  if (!writer) throw new Error('客户不支持写入')
  if (mode === 'create') {
    if (!('create' in writer) || !writer.create) throw new Error('客户不支持 create')
    const saved = await writer.create({
      code: values.code,
      name: values.name,
      shortName: values.shortName ?? null,
    })
    return String(saved.id)
  }
  if (!rowId) throw new Error('更新客户缺少 id')
  if (!('update' in writer) || !writer.update) throw new Error('客户不支持 update')
  const saved = await writer.update(rowId, {
    code: values.code,
    name: values.name,
    shortName: values.shortName ?? null,
  })
  return String(saved.id)
}
