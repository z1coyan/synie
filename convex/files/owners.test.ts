import { describe, expect, test } from 'bun:test'
import { validatedOwnerCompanyId } from './owners'

describe('附件宿主公司范围', () => {
  test('公司型宿主必须有非空公司，不能降级成全局附件', () => {
    expect(validatedOwnerCompanyId('mfg_work_order', 'company-1')).toBe('company-1')
    expect(() => validatedOwnerCompanyId('mfg_work_order', null)).toThrow('宿主公司归属缺失')
    expect(() => validatedOwnerCompanyId('sal_order_item', '')).toThrow('宿主公司归属缺失')
  })

  test('全局宿主不因损坏的多余 companyId 被扩权', () => {
    expect(validatedOwnerCompanyId('inv_material', undefined)).toBeNull()
    expect(validatedOwnerCompanyId('hr_employee', 'unexpected-company')).toBeNull()
  })
})
