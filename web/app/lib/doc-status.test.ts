import { describe, expect, test } from 'bun:test'
import {
  ATTENDANCE_DAY_STATUS_ENUM_COLORS,
  ATTENDANCE_IMPORT_STATUS_ENUM_COLORS,
  AUDIT_DOC_ACTION_VISIBLE,
  AUDIT_DOC_EDIT_ACTION_VISIBLE,
  AUDIT_DOC_STATUS_ENUM_COLORS,
  COUNT_DOC_STATUS_ENUM_COLORS,
  DEMAND_DOC_STATUS_ENUM_COLORS,
  DEMAND_ITEM_STATUS_ENUM_COLORS,
  ORDER_DOC_ACTION_VISIBLE,
  ORDER_DOC_STATUS_ENUM_COLORS,
  PAYROLL_LOAN_KIND_ENUM_COLORS,
  PAYROLL_PAYMENT_KIND_ENUM_COLORS,
  PAYROLL_SLIP_STATUS_ENUM_COLORS,
  PURCHASE_ORDER_TYPE_ENUM_COLORS,
  RECONCILIATION_DOC_STATUS_ENUM_COLORS,
  SALES_ORDER_TYPE_ENUM_COLORS,
  TRANSFER_DOC_STATUS_ENUM_COLORS,
  WORK_ORDER_STATUS_ENUM_COLORS,
  docActionVisible,
} from './doc-status'
import type { Row } from '~/components/synie-data-grid/types'

const row = (status: unknown, extra: Record<string, unknown> = {}): Row =>
  ({ id: 'r1', status, ...extra }) as Row

describe('enumColors 状态家族', () => {
  test('审核型单据', () => {
    expect(AUDIT_DOC_STATUS_ENUM_COLORS).toEqual({
      DRAFT: 'default',
      AUDITED: 'success',
      VOIDED: 'danger',
    })
  })

  test('订单型单据', () => {
    expect(ORDER_DOC_STATUS_ENUM_COLORS).toEqual({
      DRAFT: 'default',
      AUDITED: 'success',
      CLOSED: 'warning',
      VOIDED: 'danger',
    })
  })

  test('需求单与对账单口径不同,不互相统一', () => {
    expect(DEMAND_DOC_STATUS_ENUM_COLORS.CONFIRMED).toBe('success')
    expect(RECONCILIATION_DOC_STATUS_ENUM_COLORS.CONFIRMED).toBe('accent')
    expect(RECONCILIATION_DOC_STATUS_ENUM_COLORS.CLOSED).toBe('success')
    expect(DEMAND_DOC_STATUS_ENUM_COLORS.CLOSED).toBe('warning')
  })

  test('调拨/盘点/工单/需求条目', () => {
    expect(TRANSFER_DOC_STATUS_ENUM_COLORS).toEqual({
      DRAFT: 'default',
      SHIPPED: 'accent',
      RECEIVED: 'success',
    })
    expect(COUNT_DOC_STATUS_ENUM_COLORS).toEqual({
      DRAFT: 'default',
      AUDITED: 'success',
      CANCELLED: 'danger',
    })
    expect(WORK_ORDER_STATUS_ENUM_COLORS).toEqual({
      IN_PROGRESS: 'accent',
      COMPLETED: 'success',
      VOIDED: 'danger',
    })
    expect(DEMAND_ITEM_STATUS_ENUM_COLORS).toEqual({
      PENDING: 'default',
      SCHEDULED: 'accent',
      COMPLETED: 'success',
    })
  })

  test('订单分型/薪资/考勤', () => {
    expect(SALES_ORDER_TYPE_ENUM_COLORS).toEqual({ REGULAR: 'default', SAMPLE: 'accent' })
    expect(PURCHASE_ORDER_TYPE_ENUM_COLORS).toEqual({ REGULAR: 'default', SPOT: 'accent' })
    expect(PAYROLL_PAYMENT_KIND_ENUM_COLORS).toEqual({ NORMAL: 'success', SUPPLEMENT: 'accent' })
    expect(PAYROLL_SLIP_STATUS_ENUM_COLORS).toEqual({ PENDING: 'warning', PAID: 'success' })
    expect(PAYROLL_LOAN_KIND_ENUM_COLORS).toEqual({ BORROW: 'warning', REPAY: 'success' })
    expect(ATTENDANCE_IMPORT_STATUS_ENUM_COLORS).toEqual({
      PARSED: 'accent',
      FAILED: 'danger',
      IMPORTED: 'success',
    })
    expect(ATTENDANCE_DAY_STATUS_ENUM_COLORS).toEqual({ OK: 'success', MISSING: 'danger' })
  })
})

describe('docActionVisible', () => {
  test('按状态集放行,严格相等', () => {
    const vis = docActionVisible({ audit: ['DRAFT'], void: ['AUDITED'] })
    expect(vis.audit(row('DRAFT'))).toBe(true)
    expect(vis.audit(row('AUDITED'))).toBe(false)
    expect(vis.void(row('AUDITED'))).toBe(true)
    expect(vis.void(row('DRAFT'))).toBe(false)
  })

  test('状态缺失/非字符串不放行(与 row.status === X 同义)', () => {
    const vis = docActionVisible({ audit: ['DRAFT'] })
    expect(vis.audit(row(undefined))).toBe(false)
    expect(vis.audit(row(null))).toBe(false)
  })

  test('statusField 指定条目页头状态字段', () => {
    const vis = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'orderStatus')
    expect(vis.edit(row('AUDITED', { orderStatus: 'DRAFT' }))).toBe(true)
    expect(vis.auditDoc(row('DRAFT', { orderStatus: 'CLOSED' }))).toBe(false)
  })

  test('未列出的动作 key 不进映射(grid 缺省 true 放行)', () => {
    const vis = docActionVisible({ audit: ['DRAFT'] })
    expect('edit' in vis).toBe(false)
    expect('delete' in vis).toBe(false)
  })
})

describe('ACTION_VISIBLE 家族预设', () => {
  test('订单型:草稿审核/删除,已审核关闭/作废', () => {
    const draft = row('DRAFT')
    const audited = row('AUDITED')
    expect(ORDER_DOC_ACTION_VISIBLE.audit(draft)).toBe(true)
    expect(ORDER_DOC_ACTION_VISIBLE.delete(draft)).toBe(true)
    expect(ORDER_DOC_ACTION_VISIBLE.close(draft)).toBe(false)
    expect(ORDER_DOC_ACTION_VISIBLE.close(audited)).toBe(true)
    expect(ORDER_DOC_ACTION_VISIBLE.void(audited)).toBe(true)
    expect(ORDER_DOC_ACTION_VISIBLE.audit(audited)).toBe(false)
  })

  test('审核型:草稿审核/删除,已审核作废;无 edit key', () => {
    expect(AUDIT_DOC_ACTION_VISIBLE.audit(row('DRAFT'))).toBe(true)
    expect(AUDIT_DOC_ACTION_VISIBLE.void(row('AUDITED'))).toBe(true)
    expect(AUDIT_DOC_ACTION_VISIBLE.delete(row('AUDITED'))).toBe(false)
    expect('edit' in AUDIT_DOC_ACTION_VISIBLE).toBe(false)
  })

  test('审核型含编辑门控', () => {
    expect(AUDIT_DOC_EDIT_ACTION_VISIBLE.edit(row('DRAFT'))).toBe(true)
    expect(AUDIT_DOC_EDIT_ACTION_VISIBLE.edit(row('AUDITED'))).toBe(false)
    expect(AUDIT_DOC_EDIT_ACTION_VISIBLE.void(row('AUDITED'))).toBe(true)
  })
})
