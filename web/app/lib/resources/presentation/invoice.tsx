/**
 * 增值税发票 Presentation Extension：OCR、动态控件与联动的 form controller 边界。
 *
 * ResourceDocument 只声明 form.kind=extension，不含可执行代码。
 * OCR 识别、科目联动、对账单关联、附件暂存均由本 Extension 与业务页面共置实现。
 */
import type { ResourceBinding } from '../catalog/types'
import { ocrVatInvoice } from '../finance-operations'
import type { PresentationExtension } from './types'

export const VAT_INVOICE_RESOURCE = 'accVatInvoices'

/**
 * 由 accVatInvoices binding 构造；OCR transport 经本模块封装，不二次全局 client 查找。
 */
export function createInvoicePresentation(
  binding: ResourceBinding,
): PresentationExtension {
  if (binding.resource !== VAT_INVOICE_RESOURCE) {
    throw new Error(
      `发票 Presentation Extension 需要 resource=accVatInvoices，收到 ${binding.resource}`,
    )
  }
  return {
    resource: VAT_INVOICE_RESOURCE,
    kind: 'extension',
    label: '增值税发票',
    // 完整字段布局与动态 input 由发票页面 form controller 拥有（本 PE 拥有边界与 OCR seam）
    exclude: [
      'id',
      'status',
      'postingDate',
      'auditedAt',
      'auditedById',
      'createdById',
      'insertedAt',
      'updatedAt',
    ],
    fields: {},
    binding,
  }
}

/**
 * OCR 识别入口：Presentation Extension 拥有，ResourceDocument 不序列化该函数。
 * 使用 binding 资源身份校验后委托既有领域 OCR API。
 */
export function invoiceOcrRecognize(
  presentation: PresentationExtension,
): (fileId: string) => Promise<Record<string, unknown>> {
  if (presentation.resource !== VAT_INVOICE_RESOURCE) {
    throw new Error('OCR 仅适用于增值税发票 Presentation Extension')
  }
  // 校验 binding 具备 reader（只读能力投影），识别本身走领域 OCR 端点
  if (!presentation.binding.reader) {
    throw new Error('发票 binding 缺少 ResourceReader')
  }
  return (fileId: string) => ocrVatInvoice(fileId)
}

/** 经 binding.writer 提交发票主数据（金额字段由调用方已 decimal 化） */
export async function submitInvoiceForm(
  presentation: PresentationExtension,
  values: Record<string, unknown>,
  mode: 'create' | 'edit' | 'view',
  rowId: string | undefined,
): Promise<{ id: string; row: Record<string, unknown> }> {
  if (mode === 'view') throw new Error('查看模式不可提交')
  const writer = presentation.binding.writer
  if (!writer) throw new Error('发票不支持写入')
  if (mode === 'create') {
    if (!('create' in writer) || !writer.create) throw new Error('发票不支持 create')
    const saved = await writer.create(values)
    return { id: String(saved.id), row: saved as Record<string, unknown> }
  }
  if (!rowId) throw new Error('更新发票缺少 id')
  if (!('update' in writer) || !writer.update) throw new Error('发票不支持 update')
  const saved = await writer.update(rowId, values)
  return { id: String(saved.id), row: saved as Record<string, unknown> }
}
