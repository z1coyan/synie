import type { ResourceMeta } from '~/platform/meta/types.ts'
import { HR_ATTENDANCE_DAY } from './permissions.ts'
import {
  DAY_MISSING,
  DAY_OK,
  IMPORT_FAILED,
  IMPORT_IMPORTED,
  IMPORT_PARSED,
  LOAN_BORROW,
  LOAN_REPAY,
  PAYMENT_NORMAL,
  PAYMENT_SUPPLEMENT,
  PAYROLL_PAID,
  PAYROLL_PENDING,
  upperWire,
} from './rules.ts'

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name: dbName, apiName, dbColumn: dbName, type, label, ...opts }
}

const crud = [
  { key: 'read', label: '查看', scope: 'both' as const },
  { key: 'create', label: '新增', scope: 'both' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const, isDanger: true },
]

function enumOpts(values: Array<{ value: string; label: string }>) {
  return values.map((v) => ({ value: upperWire(v.value), label: v.label }))
}

export function attendancePunchResourceMeta(): ResourceMeta {
  return {
    name: 'hrAttendancePunches',
    permissionPrefix: 'hr.attendance_punch',
    permissionLabel: '打卡记录',
    table: 'hr_attendance_punch',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('attendance_no', 'attendanceNo', 'string', '考勤机编号(原始留痕)', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('punched_at', 'punchedAt', 'datetime', '打卡时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('import_id', 'importId', 'fk', '导入批次', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrAttendanceImports', relation: 'import', labelField: 'error' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'import', label: '导入', scope: 'both' },
    ],
  }
}

export function attendanceImportResourceMeta(): ResourceMeta {
  return {
    name: 'hrAttendanceImports',
    permissionPrefix: 'hr.attendance_punch',
    permissionLabel: '打卡记录',
    // 旧 GridMeta 对拍：仅 punch:read 仍可拿批次列定义，实际 action 要求 import
    readPermissionsAny: ['hr.attendance_punch:read', 'hr.attendance_punch:import'],
    table: 'hr_attendance_import',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: enumOpts([
          { value: IMPORT_PARSED, label: '已解析' },
          { value: IMPORT_FAILED, label: '解析失败' },
          { value: IMPORT_IMPORTED, label: '已导入' },
        ]),
      }),
      field('error', 'error', 'string', '解析失败原因', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('total_rows', 'totalRows', 'integer', '总行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('bad_rows', 'badRows', 'integer', '坏行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('dup_rows', 'dupRows', 'integer', '文件内重复行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('matched_rows', 'matchedRows', 'integer', '已匹配行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('unmatched_rows', 'unmatchedRows', 'integer', '未匹配行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('unmatched_detail', 'unmatchedDetail', 'string', '未匹配编号清单(编号×行数)', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('imported_count', 'importedCount', 'integer', '导入打卡数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('skipped_existing_rows', 'skippedExistingRows', 'integer', '跳过已存在行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('skipped_unmatched_rows', 'skippedUnmatchedRows', 'integer', '跳过未匹配行数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('auto_created_count', 'autoCreatedCount', 'integer', '自动创建员工数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('imported_at', 'importedAt', 'datetime', '导入时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('file_id', 'fileId', 'fk', '导入文件', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysFiles', relation: 'file', labelField: 'filename' },
      }),
      field('created_by_id', 'createdById', 'fk', '发起人', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('imported_by_id', 'importedById', 'fk', '导入人', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysUsers', relation: 'importedBy', labelField: 'name' },
      }),
      field('punch_count', 'punchCount', 'integer', '打卡数', {
        calculated: true,
        readonly: true,
      }),
    ],
    actions: [{ key: 'import', label: '导入', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function attendanceDayResourceMeta(): ResourceMeta {
  return {
    name: 'hrAttendanceDays',
    permissionPrefix: HR_ATTENDANCE_DAY.prefix,
    permissionLabel: '日考勤',
    table: 'hr_attendance_day',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('date', 'date', 'date', '日期', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('morning_in', 'morningIn', 'string', '上午上班', { sortable: true, readonly: true }),
      field('morning_out', 'morningOut', 'string', '上午下班', { sortable: true, readonly: true }),
      field('afternoon_in', 'afternoonIn', 'string', '下午上班', { sortable: true, readonly: true }),
      field('afternoon_out', 'afternoonOut', 'string', '下午下班', {
        sortable: true,
        readonly: true,
      }),
      field('normal_hours', 'normalHours', 'decimal', '正常工时', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('overtime_hours', 'overtimeHours', 'decimal', '加班工时', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('bonus_workday', 'bonusWorkday', 'decimal', '奖励工日', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: enumOpts([
          { value: DAY_OK, label: '正常' },
          { value: DAY_MISSING, label: '缺卡' },
        ]),
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '重算时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      // v1：key=import 伪装（工单 11 删除）；v2：语义 key=recalc、collection target
      {
        key: 'import',
        permissionAction: 'recalc',
        label: '重算',
        scope: 'both',
        commandTarget: 'collection',
      },
    ],
  }
}

export function attendanceCorrectionResourceMeta(): ResourceMeta {
  return {
    name: 'hrAttendanceCorrections',
    permissionPrefix: 'hr.attendance_correction',
    permissionLabel: '补卡单',
    table: 'hr_attendance_correction',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('date', 'date', 'date', '日期', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('times', 'times', 'string', '补卡时刻', { required: true }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        required: true,
        filterable: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
    ],
    actions: crud,
    form: {
      kind: 'basic',
      exclude: ['id', 'createdById', 'insertedAt', 'updatedAt'],
      fields: {
        employeeId: { order: -1 },
        times: { initial: ['08:00:00'] },
        note: { placeholder: '如 考勤机故障、外出办事漏打' },
      },
    },
    audit: { enabled: true },

  }
}

export function payrollResourceMeta(): ResourceMeta {
  return {
    name: 'hrPayrolls',
    permissionPrefix: 'hr.payroll',
    permissionLabel: '工资单',
    table: 'hr_payroll',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('month', 'month', 'string', '月份', { filterable: true, sortable: true, readonly: true }),
      field('workdays', 'workdays', 'decimal', '月工日', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('attendance_days', 'attendanceDays', 'integer', '出勤天数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('missing_days', 'missingDays', 'integer', '缺卡天数', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('overtime_hours', 'overtimeHours', 'decimal', '加班工时', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('daily_wage', 'dailyWage', 'decimal', '日薪', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('base_amount', 'baseAmount', 'decimal', '基本工资', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('allowance', 'allowance', 'decimal', '补贴', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('bonus', 'bonus', 'decimal', '奖金', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('fine', 'fine', 'decimal', '罚款', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('loan_deduction', 'loanDeduction', 'decimal', '借款抵扣', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('payable', 'payable', 'decimal', '应发工资', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: enumOpts([
          { value: PAYROLL_PENDING, label: '待发放' },
          { value: PAYROLL_PAID, label: '已发放' },
        ]),
      }),
      field('remarks', 'remarks', 'string', '备注', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('paid_total', 'paidTotal', 'decimal', '实发合计', {
        calculated: true,
        readonly: true,
      }),
    ],
    actions: crud,
    printHead: true,
    printLoops: [{ name: 'payments', resource: 'hrPayrollPayments' }],
    audit: { enabled: true },

  }
}

export function payrollPaymentResourceMeta(): ResourceMeta {
  return {
    name: 'hrPayrollPayments',
    permissionPrefix: 'hr.payroll_payment',
    permissionLabel: '工资发放',
    table: 'hr_payroll_payment',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('month', 'month', 'string', '月份', { filterable: true, sortable: true, readonly: true }),
      field('paid_on', 'paidOn', 'date', '发放日期', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('amount', 'amount', 'decimal', '发放金额', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('kind', 'kind', 'enum', '类型', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: enumOpts([
          { value: PAYMENT_NORMAL, label: '发放' },
          { value: PAYMENT_SUPPLEMENT, label: '补发' },
        ]),
      }),
      field('remarks', 'remarks', 'string', '备注', {
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('payroll_id', 'payrollId', 'fk', '工资单', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrPayrolls', relation: 'payroll', labelField: 'month' },
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '经办人', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    form: {
      kind: 'basic',
      exclude: [
        'id',
        'payrollId',
        'employeeId',
        'month',
        'kind',
        'createdById',
        'insertedAt',
        'updatedAt',
      ],
    },
    audit: { enabled: true },

  }
}

export function employeeLoanResourceMeta(): ResourceMeta {
  return {
    name: 'hrEmployeeLoans',
    permissionPrefix: 'hr.employee_loan',
    permissionLabel: '员工借款',
    table: 'hr_employee_loan',
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('kind', 'kind', 'enum', '类型', {
        required: true,
        filterable: true,
        sortable: true,
        enumOptions: enumOpts([
          { value: LOAN_BORROW, label: '借款' },
          { value: LOAN_REPAY, label: '归还' },
        ]),
      }),
      field('occurred_on', 'occurredOn', 'date', '发生日期', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('amount', 'amount', 'decimal', '金额', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('remarks', 'remarks', 'string', '备注', {
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
        readonly: true,
      }),
      field('employee_id', 'employeeId', 'fk', '员工', {
        required: true,
        filterable: true,
        ref: { resource: 'hrEmployees', relation: 'employee', labelField: 'name' },
      }),
      field('payroll_id', 'payrollId', 'fk', '关联工资单', {
        filterable: true,
        readonly: true,
        ref: { resource: 'hrPayrolls', relation: 'payroll', labelField: 'month' },
      }),
      field('created_by_id', 'createdById', 'fk', '经办人', {
        filterable: true,
        readonly: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
    ],
    actions: crud,
    form: {
      kind: 'basic',
      exclude: ['id', 'payrollId', 'createdById', 'insertedAt', 'updatedAt'],
      fields: {
        employeeId: { order: -3 },
        kind: { initial: LOAN_BORROW, order: -2 },
        occurredOn: { order: -1 },
        remarks: { placeholder: '如 预支生活费、现金还款' },
      },
    },
    audit: { enabled: true },

  }
}

export function allHrResourceMetas(): ResourceMeta[] {
  return [
    attendancePunchResourceMeta(),
    attendanceImportResourceMeta(),
    attendanceDayResourceMeta(),
    attendanceCorrectionResourceMeta(),
    payrollResourceMeta(),
    payrollPaymentResourceMeta(),
    employeeLoanResourceMeta(),
  ]
}
