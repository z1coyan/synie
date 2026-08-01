/**
 * 示例数据共享工具：幂等标记、半成品清理、主数据查找。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'

/** 客户 C01：业务侧幂等标识之一 */
export const MARKER_CUSTOMER_CODE = 'C01'

/**
 * 财务种子写入的银行账号，作为「示例数据整组成功」标记。
 * 不能只用 C01：中途失败时客户已存在，整组跳过会导致 BOM/委外/财务永久缺失。
 */
export const MARKER_BANK_ACCOUNT_NO = '377601886688901'

export function daysAgo(n: number): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - n)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysAgoAt(n: number, hour: number): string {
  const day = daysAgo(n)
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`
}

export function previousMonth(): string {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  first.setUTCDate(0)
  const y = first.getUTCFullYear()
  const m = String(first.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export async function alreadySeeded(db: Kysely<Database>): Promise<boolean> {
  const row = await sql<{ e: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM acc_bank_account WHERE account_no = ${MARKER_BANK_ACCOUNT_NO}
    ) AS e
  `.execute(db)
  return Boolean(row.rows[0]?.e)
}

/** 上次示例种子中途失败（有 C01 但无完成标记） */
export async function partialSampleStarted(db: Kysely<Database>): Promise<boolean> {
  const customer = await sql<{ e: boolean }>`
    SELECT EXISTS (SELECT 1 FROM sal_customers WHERE code = ${MARKER_CUSTOMER_CODE}) AS e
  `.execute(db)
  if (!customer.rows[0]?.e) return false
  const bank = await sql<{ e: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM acc_bank_account WHERE account_no = ${MARKER_BANK_ACCOUNT_NO}
    ) AS e
  `.execute(db)
  return !bank.rows[0]?.e
}

/** 清掉中断的示例业务数据，保留公司/科目/仓库/用户与基础种子 */
export async function wipePartialSample(db: Kysely<Database>): Promise<void> {
  try {
    await sql`
      TRUNCATE TABLE
        acc_vat_invoice,
        acc_expense_report_item,
        acc_expense_report,
        hr_payroll_payment,
        hr_payroll,
        acc_gl_journal_line,
        acc_gl_journal,
        acc_bank_transaction,
        acc_bank_reconciliation,
        acc_bank_import_item,
        acc_bank_import,
        acc_bank_account,
        acc_gl_entry,
        pur_reconciliation_item,
        pur_reconciliation,
        pur_outsourced_receipt_item_byproduct,
        pur_outsourced_receipt_item_material,
        pur_outsourced_receipt_item,
        pur_outsourced_receipt,
        pur_outsourced_issue_item,
        pur_outsourced_issue,
        pur_receipt_item,
        pur_receipt,
        pur_order_item_byproduct,
        pur_order_item_material,
        pur_order_item,
        pur_order,
        pur_quotation_tier,
        pur_quotation_item,
        pur_quotation,
        sal_reconciliation_item,
        sal_reconciliation,
        sal_delivery_item,
        sal_delivery,
        sal_order_item,
        sal_order,
        sal_quotation_tier,
        sal_quotation_item,
        sal_quotation,
        inv_stock_count_item,
        inv_stock_count,
        inv_stock_transfer_item,
        inv_stock_transfer,
        inv_stock_doc_item,
        inv_stock_doc,
        inv_stock_entry,
        mfg_output_item,
        mfg_output,
        mfg_work_order,
        mfg_demand_item,
        mfg_demand,
        mfg_bom_route,
        mfg_bom_byproduct,
        mfg_bom_component,
        mfg_bom,
        mfg_process_template_item,
        mfg_process_template,
        mfg_operation,
        inv_material_unit,
        inv_material,
        hr_attendance_correction,
        hr_attendance_day,
        hr_attendance_punch,
        hr_attendance_import,
        hr_employee_loan,
        hr_employees,
        pur_supplier,
        sal_customers
      RESTART IDENTITY CASCADE
    `.execute(db)
  } catch (err) {
    throw new ApiError('internal', '清理中断的示例数据失败', { cause: err })
  }
}

export async function unitBySymbol(db: Kysely<Database>, symbol: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM bas_unit WHERE symbol = ${symbol}
  `.execute(db)
  if (!row.rows[0]) {
    throw new ApiError(
      'conflict',
      `示例数据需要计量单位 ${symbol},请先完成初始化单位种子`,
    )
  }
  return row.rows[0].id
}

export async function leafCategory(db: Kysely<Database>, code: string): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM inv_material_category WHERE code = ${code}
  `.execute(db)
  if (!row.rows[0]) {
    throw new ApiError(
      'conflict',
      `示例数据需要物料分类 ${code},请先完成初始化分类种子`,
    )
  }
  return row.rows[0].id
}

export async function accountByCode(
  db: Kysely<Database>,
  companyId: string,
  code: string,
): Promise<string> {
  const row = await sql<{ id: string }>`
    SELECT id FROM bas_account WHERE company_id = ${companyId}::uuid AND code = ${code}
  `.execute(db)
  if (!row.rows[0]) {
    throw new ApiError(
      'conflict',
      `示例数据需要科目 ${code}(按小企业会计准则模板),请先完成科目表初始化`,
    )
  }
  return row.rows[0].id
}

export async function warehouseBySuffix(
  db: Kysely<Database>,
  companyId: string,
  suffix: string,
): Promise<string> {
  const rows = await sql<{ id: string; name: string }>`
    SELECT id, name FROM inv_warehouse WHERE company_id = ${companyId}::uuid
  `.execute(db)
  for (const r of rows.rows) {
    if (r.name.endsWith(suffix)) return r.id
  }
  throw new ApiError(
    'conflict',
    `示例数据需要名称以「${suffix}」结尾的仓库,请先完成默认仓库种子`,
  )
}

export interface CompanyInfo {
  id: string
  code: string
  name: string
  shortName: string
  baseCurrencyId: string
}

export async function loadCompany(
  db: Kysely<Database>,
  companyId: string,
): Promise<CompanyInfo> {
  const row = await sql<{
    id: string
    code: string
    name: string
    short_name: string
    base_currency_id: string
  }>`
    SELECT id, code, name, short_name, base_currency_id
    FROM bas_company WHERE id = ${companyId}::uuid
  `.execute(db)
  const c = row.rows[0]
  if (!c) {
    throw new ApiError('internal', '读取示例数据公司失败')
  }
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    shortName: c.short_name,
    baseCurrencyId: c.base_currency_id,
  }
}

export interface Accounts {
  unbilledAR: string
  unbilledAP: string
  revenue: string
  inventory: string
  bank: string
  capital: string
  expense: string
  receivable: string
  payable: string
  tax: string
}

export interface Warehouses {
  default: string
  transit: string
  finished: string
  root: string
}

export interface SeedCtx {
  company: CompanyInfo
  accounts: Accounts
  warehouses: Warehouses
}

export interface MaterialRef {
  id: string
  defaultUnitId: string
}

export interface MasterData {
  company: CompanyInfo
  customers: Record<string, { id: string; code: string; name: string; shortName: string | null }>
  suppliers: Record<string, { id: string; code: string; name: string; shortName: string | null }>
  materials: Record<string, MaterialRef>
  employees: Record<string, { id: string; name: string }>
}
