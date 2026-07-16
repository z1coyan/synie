import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CodeBlock } from '@heroui-pro/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/logs')({
  component: LogsPage,
})

const ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  destroy: '删除',
  reset_password: '重置密码',
  audit: '审核',
  cancel: '取消',
  void: '作废',
  reverse: '红冲',
  quick_create: '快速对账',
  refresh_reconcile: '对账刷新',
  import: '执行导入',
  refresh: '重取快照',
  mark_paid: '标记已发放',
  mark_pending: '翻回待发放',
  auto_repay: '联动归还',
  auto_destroy: '联动删除',
}

// 值为 Track 落库的 GraphQL type 名;新资源接审计后在此补中文,漏了则原样显示英文
const RESOURCE_LABELS: Record<string, string> = {
  sys_role: '角色',
  sys_user: '用户',
  sys_user_role: '用户角色',
  sys_role_permission: '角色权限',
  sys_user_company: '用户公司授权',
  bas_company: '公司',
  bas_currency: '货币',
  bas_unit: '计量单位',
  bas_account: '会计科目',
  sal_customer: '客户',
  pur_supplier: '供应商',
  hr_employee: '员工',
  hr_attendance_import: '考勤导入',
  hr_attendance_correction: '补卡单',
  hr_payroll: '工资单',
  hr_payroll_payment: '工资发放记录',
  hr_employee_loan: '员工借款',
  inv_material_category: '物料分类',
  sys_file: '附件文件',
  sys_attachment: '附件关联',
  sys_storage: '存储接入',
  acc_gl_journal: '会计凭证',
  acc_gl_journal_line: '凭证分录行',
  acc_bank_account: '银行账户',
  acc_bank_transaction: '银行流水',
  acc_bank_import_template: '流水导入模板',
  acc_bank_import: '银行流水导入',
  acc_bank_import_item: '流水导入行',
  acc_vat_invoice: '增值税发票',
  acc_bill: '承兑票据',
  acc_bill_transaction: '承兑交易',
  sys_numbering_rule: '编号规则',
  sys_numbering_counter: '编号计数器',
  acc_bank_reconciliation: '银行对账记录',
  acc_setting: '财务设置',
}

// id 列展示原始 uuid 无阅读价值,记录名称/操作人已够定位;需要按 id 排查时直接查库
const EXCLUDE = ['recordId', 'actorId', 'companyId']

/** changes 经 GraphQL JsonString 标量到达是 JSON 串;兼容将来切 Json 标量直接给对象的情况 */
function parseChanges(value: unknown): Record<string, { from?: unknown; to?: unknown }> | null {
  const parsed = typeof value === 'string' && value ? safeJsonParse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, { from?: unknown; to?: unknown }>)
    : null
}

function safeJsonParse(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const actionLabel = (value: unknown) => ACTION_LABELS[String(value)] ?? String(value)
const resourceLabel = (value: unknown) => RESOURCE_LABELS[String(value)] ?? String(value)

function changesSummary(value: unknown) {
  const changes = parseChanges(value)
  const count = changes ? Object.keys(changes).length : 0
  return count > 0 ? `${count} 项变更` : <span className="text-muted">—</span>
}

/** 抽屉详情:变更 JSON 代码块(带复制) */
function ChangesJson({ value }: { value: unknown }) {
  const changes = parseChanges(value)
  if (!changes || Object.keys(changes).length === 0) return <span className="text-muted">—</span>
  const code = JSON.stringify(changes, null, 2)
  return (
    <CodeBlock>
      <CodeBlock.Header>
        <span className="text-muted text-xs uppercase">json</span>
        <CodeBlock.CopyButton code={code} />
      </CodeBlock.Header>
      <CodeBlock.Code code={code} language="json" />
    </CodeBlock>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  resource: { render: resourceLabel },
  actionType: { render: actionLabel },
  actionName: { render: actionLabel },
  changes: { render: changesSummary },
}

function LogsPage() {
  const [row, setRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">操作日志</h1>
      <p className="mt-2 text-sm text-ink-500">系统数据变更的审计记录,只读。</p>

      <div className="mt-6">
        {/* 审计日志只读:不传 onCreate/onEdit 即无新增/编辑入口 */}
        <SynieDataGrid
          resource="sysAuditLogs"
          exclude={EXCLUDE}
          overrides={GRID_OVERRIDES}
          onView={setRow}
        />
      </div>

      <SynieRecordDrawer
        resource="sysAuditLogs"
        label="操作日志"
        mode="view"
        isOpen={row !== null}
        onOpenChange={(open) => !open && setRow(null)}
        row={row}
        exclude={EXCLUDE}
        fields={{
          resource: { render: resourceLabel },
          actionType: { render: actionLabel, cols: 6 },
          actionName: { render: actionLabel, cols: 6 },
          changes: { render: (v) => <ChangesJson value={v} /> },
        }}
      />
    </>
  )
}
