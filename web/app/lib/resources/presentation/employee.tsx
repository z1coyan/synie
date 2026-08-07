/**
 * 员工 Presentation Extension：主数据字段 + 身份证影像。
 * ResourceDocument 仅声明 form.kind=extension。
 */
import { formatAmount } from '~/lib/amount'
import { SynieImageAttachment } from '~/components/synie-attachment-panel/SynieImageAttachment'
import { requireWriter } from '../catalog/require-writer'
import type { ResourceBinding } from '../catalog/types'
import type { PresentationExtension } from './types'

export const EMPLOYEE_RESOURCE = 'hrEmployees'

export function createEmployeePresentation(
  binding: ResourceBinding,
): PresentationExtension {
  if (binding.resource !== EMPLOYEE_RESOURCE) {
    throw new Error(
      `员工 Presentation Extension 需要 resource=hrEmployees，收到 ${binding.resource}`,
    )
  }
  return {
    resource: EMPLOYEE_RESOURCE,
    kind: 'extension',
    label: '员工',
    exclude: ['id', 'insertedAt', 'updatedAt'],
    fields: {
      // 系统生成编号（ADR 2026-08-06）：readOnly 不进 create wire（对齐 material / meta.form）
      code: {
        order: 0,
        cols: 6,
        required: false,
        edit: 'readOnly',
        placeholder: '保存后自动编号',
      },
      name: { order: 1, cols: 6, required: true },
      attendanceNo: { order: 2, cols: 6 },
      phone: { order: 3, cols: 6 },
      idNumber: { order: 4 },
      householdRegistration: { order: 5 },
      currentAddress: { order: 6 },
      dailyWage: { order: 7, cols: 6, render: (v) => formatAmount(v) },
      monthlyAllowance: { order: 8, cols: 6, render: (v) => formatAmount(v) },
      insuranceTypes: { order: 9 },
    },
    binding,
    extraContent: (mode, row) => (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SynieImageAttachment
          ownerType="hr_employee"
          ownerId={row?.id as string | undefined}
          category="id_front"
          label="身份证正面"
          readonly={mode === 'view'}
        />
        <SynieImageAttachment
          ownerType="hr_employee"
          ownerId={row?.id as string | undefined}
          category="id_back"
          label="身份证背面"
          readonly={mode === 'view'}
        />
      </div>
    ),
  }
}

export async function submitEmployeeForm(
  presentation: PresentationExtension,
  values: Record<string, unknown>,
  mode: 'create' | 'edit' | 'view',
  rowId: string | undefined,
): Promise<string> {
  if (mode === 'view') throw new Error('查看模式不可提交')
  if (mode === 'create') {
    const saved = await requireWriter(presentation.binding, 'create')(values)
    return String(saved.id)
  }
  if (!rowId) throw new Error('更新员工缺少 id')
  const saved = await requireWriter(presentation.binding, 'update')(rowId, values)
  return String(saved.id)
}
