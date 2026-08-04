/**
 * 流水导入模板 / 导入批次 / 导入行。
 */
import { type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated, auditDestroyed, auditDiff, writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { requireCompanyAccess, requirePermission, type Actor } from '~/platform/authz/actor.ts'
import type { FileService } from '~/platform/files/service.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { parseBankImport, type ParseTemplate } from './bank-parser.ts'
import { validateOwnBankAccount } from './banking-accounts.ts'
import { validateTxnShape, type BankTransaction } from './banking-shared.ts'
import {
  actorUserId, asIso, asIsoOrNull, conflict, lower, notFound,
  requireCompanyWrite, truncateRunes, upper, validateOptionalText,
  validateRequiredText, validation, wireDec, wireEnum,
} from './common.ts'
import {
  bankImportItemResourceMeta, bankImportResourceMeta, bankImportTemplateResourceMeta,
} from './meta.ts'

export interface BankImportTemplate {
  id: string; name: string; startRow: number
  datetimeCol: string | null; datetimeFormat: string | null
  dateCol: string | null; dateFormat: string | null
  timeCol: string | null; timeFormat: string | null
  incomeCol: string | null; expenseCol: string | null; amountCol: string | null
  balanceCol: string | null; counterpartyNameCol: string | null
  counterpartyAccountCol: string | null; summaryCol: string | null; noteCol: string | null
  insertedAt: string; updatedAt: string; companyId: string; bankAccountId: string
}

export interface BankImport {
  id: string; status: string; error: string | null; importedAt: string | null
  insertedAt: string; updatedAt: string; companyId: string; bankAccountId: string
  templateId: string; fileId: string; createdById: string | null; importedById: string | null
  itemCount: number; errorCount: number
}

export interface BankImportItem {
  id: string; rowNo: number; occurredAt: string | null
  income: string | null; expense: string | null; balance: string | null
  counterpartyName: string | null; counterpartyAccount: string | null
  summary: string | null; note: string | null; error: string | null
  insertedAt: string; updatedAt: string; importId: string; companyId: string
  transactionId: string | null
}

const TEMPLATE_AUDIT = auditFieldsOf(bankImportTemplateResourceMeta())
const IMPORT_AUDIT = auditFieldsOf(bankImportResourceMeta())
const ITEM_AUDIT = auditFieldsOf(bankImportItemResourceMeta())
const COLUMN_RE = /^[A-Z]{1,2}$/
const WRITE_MAP = [
  { code: '23505', message: '银行业务记录冲突' },
  { code: '23503', message: '银行业务引用不存在' },
] as const

function mapTemplate(row: Record<string, unknown>): BankImportTemplate {
  const up = (v: unknown) => (v == null ? null : upper(String(v)))
  return {
    id: String(row.id), name: String(row.name), startRow: Number(row.start_row),
    datetimeCol: row.datetime_col == null ? null : String(row.datetime_col),
    datetimeFormat: up(row.datetime_format),
    dateCol: row.date_col == null ? null : String(row.date_col),
    dateFormat: up(row.date_format),
    timeCol: row.time_col == null ? null : String(row.time_col),
    timeFormat: up(row.time_format),
    incomeCol: row.income_col == null ? null : String(row.income_col),
    expenseCol: row.expense_col == null ? null : String(row.expense_col),
    amountCol: row.amount_col == null ? null : String(row.amount_col),
    balanceCol: row.balance_col == null ? null : String(row.balance_col),
    counterpartyNameCol: row.counterparty_name_col == null ? null : String(row.counterparty_name_col),
    counterpartyAccountCol: row.counterparty_account_col == null ? null : String(row.counterparty_account_col),
    summaryCol: row.summary_col == null ? null : String(row.summary_col),
    noteCol: row.note_col == null ? null : String(row.note_col),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), bankAccountId: String(row.bank_account_id),
  }
}

function mapImport(row: Record<string, unknown>): BankImport {
  return {
    id: String(row.id), status: wireEnum(row.status),
    error: row.error == null ? null : String(row.error),
    importedAt: asIsoOrNull(row.imported_at),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    companyId: String(row.company_id), bankAccountId: String(row.bank_account_id),
    templateId: String(row.template_id), fileId: String(row.file_id),
    createdById: row.created_by_id == null ? null : String(row.created_by_id),
    importedById: row.imported_by_id == null ? null : String(row.imported_by_id),
    itemCount: Number(row.item_count ?? 0), errorCount: Number(row.error_count ?? 0),
  }
}

function mapItem(row: Record<string, unknown>): BankImportItem {
  return {
    id: String(row.id), rowNo: Number(row.row_no),
    occurredAt: asIsoOrNull(row.occurred_at),
    income: wireDec(row.income), expense: wireDec(row.expense), balance: wireDec(row.balance),
    counterpartyName: row.counterparty_name == null ? null : String(row.counterparty_name),
    counterpartyAccount: row.counterparty_account == null ? null : String(row.counterparty_account),
    summary: row.summary == null ? null : String(row.summary),
    note: row.note == null ? null : String(row.note),
    error: row.error == null ? null : String(row.error),
    insertedAt: asIso(row.inserted_at), updatedAt: asIso(row.updated_at),
    importId: String(row.import_id), companyId: String(row.company_id),
    transactionId: row.transaction_id == null ? null : String(row.transaction_id),
  }
}

function templateSnap(t: BankImportTemplate): Record<string, unknown> {
  return {
    name: t.name, start_row: t.startRow, datetime_col: t.datetimeCol,
    datetime_format: t.datetimeFormat, date_col: t.dateCol, date_format: t.dateFormat,
    time_col: t.timeCol, time_format: t.timeFormat, income_col: t.incomeCol,
    expense_col: t.expenseCol, amount_col: t.amountCol, balance_col: t.balanceCol,
    counterparty_name_col: t.counterpartyNameCol, counterparty_account_col: t.counterpartyAccountCol,
    summary_col: t.summaryCol, note_col: t.noteCol, company_id: t.companyId,
    bank_account_id: t.bankAccountId,
  }
}

function importSnap(i: BankImport): Record<string, unknown> {
  return {
    status: lower(i.status), error: i.error, imported_at: i.importedAt,
    company_id: i.companyId, bank_account_id: i.bankAccountId, template_id: i.templateId,
    file_id: i.fileId, created_by_id: i.createdById, imported_by_id: i.importedById,
  }
}

function itemSnap(i: BankImportItem): Record<string, unknown> {
  return {
    row_no: i.rowNo, occurred_at: i.occurredAt, income: i.income, expense: i.expense,
    balance: i.balance, counterparty_name: i.counterpartyName,
    counterparty_account: i.counterpartyAccount, summary: i.summary, note: i.note,
    error: i.error, import_id: i.importId, company_id: i.companyId, transaction_id: i.transactionId,
  }
}

function normalizeCol(v: string | null | undefined): string | null {
  if (v == null) return null
  return upper(v)
}

function validateTemplateShape(t: {
  name: string; startRow: number
  datetimeCol: string | null; datetimeFormat: string | null
  dateCol: string | null; dateFormat: string | null
  timeCol: string | null; timeFormat: string | null
  incomeCol: string | null; expenseCol: string | null; amountCol: string | null
  columns: (string | null)[]
}): void {
  const fields: Record<string, string[]> = {}
  validateRequiredText(fields, 'name', t.name, 64)
  if (t.startRow < 1) fields.startRow = ['必须大于等于 1']
  for (const col of t.columns) {
    if (col != null && !COLUMN_RE.test(col)) {
      fields.columns = ['列号须为 1-2 位字母(如 D、AA)']
      break
    }
  }
  const dtFormats = new Set(['YMD_DASH_HMS','YMD_DASH_HM','YMD_SLASH_HMS','YMD_SLASH_HM','COMPACT_SPACE','COMPACT','ISO_T','CN_HMS','MDY_SLASH_HMS','DMY_SLASH_HMS'])
  const dFormats = new Set(['YMD_DASH','YMD_SLASH','YMD_COMPACT','YMD_DOT','YMD_CN','MDY_SLASH','DMY_SLASH','DMY_DASH'])
  const tFormats = new Set(['HMS','HM','HMS_COMPACT','HMS_CN'])
  if (t.datetimeFormat && !dtFormats.has(t.datetimeFormat)) fields.datetimeFormat = ['不是有效的格式']
  if (t.dateFormat && !dFormats.has(t.dateFormat)) fields.dateFormat = ['不是有效的格式']
  if (t.timeFormat && !tFormats.has(t.timeFormat)) fields.timeFormat = ['不是有效的格式']
  const singleAny = t.datetimeCol != null || t.datetimeFormat != null
  const doubleAny = t.dateCol != null || t.dateFormat != null || t.timeCol != null || t.timeFormat != null
  if (!singleAny && !doubleAny) fields.datetimeCol = ['必须配置日期时间列或日期列']
  else if (singleAny && doubleAny) fields.datetimeCol = ['时间配置二选一:日期时间单列与日期/时间双列不可混填']
  else if (singleAny && t.datetimeCol == null) fields.datetimeCol = ['填了日期时间格式但缺日期时间列']
  else if (singleAny && t.datetimeFormat == null) fields.datetimeFormat = ['日期时间列必须选择格式']
  else if (doubleAny && t.dateCol == null) fields.dateCol = ['填了日期格式/时间列但缺日期列']
  else if (doubleAny && t.dateFormat == null) fields.dateFormat = ['日期列必须选择格式']
  else if (t.timeCol != null && t.timeFormat == null) fields.timeFormat = ['时间列必须选择格式']
  else if (t.timeCol == null && t.timeFormat != null) fields.timeCol = ['填了时间格式但缺时间列']
  if (t.amountCol != null && (t.incomeCol != null || t.expenseCol != null)) {
    fields.amountCol = ['带符号金额列与收入/支出列不可同时配置']
  } else if (t.amountCol == null && t.incomeCol == null && t.expenseCol == null) {
    fields.incomeCol = ['必须配置收入/支出列或带符号金额列']
  }
  if (Object.keys(fields).length) throw validation('流水导入模板', fields)
}

async function loadTemplate(db: DbHandle, id: string, lock: boolean): Promise<BankImportTemplate> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,name,start_row,datetime_col,datetime_format,date_col,date_format,time_col,
      time_format,income_col,expense_col,amount_col,balance_col,counterparty_name_col,
      counterparty_account_col,summary_col,note_col,inserted_at,updated_at,company_id,bank_account_id
    FROM acc_bank_import_template WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('流水导入模板')
  return mapTemplate(rows.rows[0])
}

async function loadImport(db: DbHandle, id: string, lock: boolean): Promise<BankImport> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,status,error,imported_at,inserted_at,updated_at,company_id,bank_account_id,
      template_id,file_id,created_by_id,imported_by_id,
      (SELECT count(*) FROM acc_bank_import_item ii WHERE ii.import_id=acc_bank_import.id) AS item_count,
      (SELECT count(*) FROM acc_bank_import_item ii WHERE ii.import_id=acc_bank_import.id AND ii.error IS NOT NULL) AS error_count
    FROM acc_bank_import WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('流水导入记录')
  return mapImport(rows.rows[0])
}

async function loadItem(db: DbHandle, id: string, lock: boolean): Promise<BankImportItem> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,row_no,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
      summary,note,error,inserted_at,updated_at,import_id,company_id,transaction_id
    FROM acc_bank_import_item WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db)
  if (!rows.rows[0]) throw notFound('流水导入行')
  return mapItem(rows.rows[0])
}

export function createImportOps(
  db: Kysely<Database>,
  deps: {
    files: Pick<FileService, 'readStoredFile'> | null
    createTransactionInTx: (
      trx: DbHandle, actor: Actor,
      input: {
        occurredAt: string; income?: string | null; expense?: string | null; balance?: string | null
        counterpartyName?: string | null; counterpartyAccount?: string | null
        summary?: string | null; note?: string | null; companyId: string; bankAccountId: string
      },
      requireActive: boolean,
    ) => Promise<BankTransaction>
    utcOffsetMs?: number
  },
) {
  const files = deps.files
  const utcOffsetMs = deps.utcOffsetMs ?? 8 * 60 * 60 * 1000

  async function listTemplates(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'acc.bank_import_template:read', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankImportTemplate[] }
    return listFromSource({
      db, resource: bankImportTemplateResourceMeta(),
      source: sql` FROM acc_bank_import_template`,
      select: sql`SELECT id,name,start_row,datetime_col,datetime_format,date_col,date_format,time_col,
        time_format,income_col,expense_col,amount_col,balance_col,counterparty_name_col,
        counterparty_account_col,summary_col,note_col,inserted_at,updated_at,company_id,bank_account_id`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapTemplate,
    })
  }

  async function getTemplate(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_import_template:read', '无权限执行银行业务操作')
    const item = await loadTemplate(db, id, false)
    requireCompanyAccess(actor, item.companyId, '流水导入模板不存在')
    return item
  }

  async function createTemplate(actor: Actor, input: {
    name: string; startRow?: number
    datetimeCol?: string | null; datetimeFormat?: string | null
    dateCol?: string | null; dateFormat?: string | null
    timeCol?: string | null; timeFormat?: string | null
    incomeCol?: string | null; expenseCol?: string | null; amountCol?: string | null
    balanceCol?: string | null; counterpartyNameCol?: string | null
    counterpartyAccountCol?: string | null; summaryCol?: string | null; noteCol?: string | null
    companyId: string; bankAccountId: string
  }) {
    requirePermission(actor, 'acc.bank_import_template:create', '无权限执行银行业务操作')
    requireCompanyWrite(actor, input.companyId)
    const name = input.name.trim()
    const startRow = input.startRow && input.startRow !== 0 ? input.startRow : 2
    const datetimeCol = normalizeCol(input.datetimeCol)
    const datetimeFormat = normalizeCol(input.datetimeFormat)
    const dateCol = normalizeCol(input.dateCol)
    const dateFormat = normalizeCol(input.dateFormat)
    const timeCol = normalizeCol(input.timeCol)
    const timeFormat = normalizeCol(input.timeFormat)
    const incomeCol = normalizeCol(input.incomeCol)
    const expenseCol = normalizeCol(input.expenseCol)
    const amountCol = normalizeCol(input.amountCol)
    const balanceCol = normalizeCol(input.balanceCol)
    const counterpartyNameCol = normalizeCol(input.counterpartyNameCol)
    const counterpartyAccountCol = normalizeCol(input.counterpartyAccountCol)
    const summaryCol = normalizeCol(input.summaryCol)
    const noteCol = normalizeCol(input.noteCol)
    validateTemplateShape({
      name, startRow, datetimeCol, datetimeFormat, dateCol, dateFormat, timeCol, timeFormat,
      incomeCol, expenseCol, amountCol,
      columns: [datetimeCol, dateCol, timeCol, incomeCol, expenseCol, amountCol, balanceCol,
        counterpartyNameCol, counterpartyAccountCol, summaryCol, noteCol],
    })
    return withTx(db, async (trx) => {
      await validateOwnBankAccount(trx, input.companyId, input.bankAccountId, false)
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_bank_import_template(
            name,start_row,datetime_col,datetime_format,date_col,date_format,time_col,time_format,
            income_col,expense_col,amount_col,balance_col,counterparty_name_col,
            counterparty_account_col,summary_col,note_col,company_id,bank_account_id)
          VALUES (
            ${name},${startRow},${datetimeCol},${datetimeFormat ? lower(datetimeFormat) : null},
            ${dateCol},${dateFormat ? lower(dateFormat) : null},${timeCol},${timeFormat ? lower(timeFormat) : null},
            ${incomeCol},${expenseCol},${amountCol},${balanceCol},${counterpartyNameCol},
            ${counterpartyAccountCol},${summaryCol},${noteCol},
            ${input.companyId}::uuid,${input.bankAccountId}::uuid)
          RETURNING id
        `.execute(trx)
        const item = await loadTemplate(trx, ins.rows[0]!.id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import_template', recordId: item.id, recordLabel: item.name,
          companyId: item.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(templateSnap(item), TEMPLATE_AUDIT),
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建流水导入模板失败', WRITE_MAP)
      }
    })
  }

  async function updateTemplate(actor: Actor, id: string, input: Record<string, unknown> & {
    name?: string; startRow?: number; bankAccountId?: string
  }) {
    requirePermission(actor, 'acc.bank_import_template:update', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const before = await loadTemplate(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '流水导入模板不存在')
      const after = { ...before }
      if (input.name !== undefined) after.name = String(input.name)
      if (input.startRow !== undefined) after.startRow = Number(input.startRow)
      const opt = (key: string, field: keyof BankImportTemplate) => {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          const v = input[key]
          ;(after as Record<string, unknown>)[field] = v == null ? null : normalizeCol(String(v))
        }
      }
      opt('datetimeCol', 'datetimeCol'); opt('datetimeFormat', 'datetimeFormat')
      opt('dateCol', 'dateCol'); opt('dateFormat', 'dateFormat')
      opt('timeCol', 'timeCol'); opt('timeFormat', 'timeFormat')
      opt('incomeCol', 'incomeCol'); opt('expenseCol', 'expenseCol'); opt('amountCol', 'amountCol')
      opt('balanceCol', 'balanceCol'); opt('counterpartyNameCol', 'counterpartyNameCol')
      opt('counterpartyAccountCol', 'counterpartyAccountCol'); opt('summaryCol', 'summaryCol')
      opt('noteCol', 'noteCol')
      if (input.bankAccountId !== undefined) after.bankAccountId = String(input.bankAccountId)
      after.name = after.name.trim()
      if (after.datetimeFormat) after.datetimeFormat = upper(after.datetimeFormat)
      if (after.dateFormat) after.dateFormat = upper(after.dateFormat)
      if (after.timeFormat) after.timeFormat = upper(after.timeFormat)
      validateTemplateShape({
        name: after.name, startRow: after.startRow,
        datetimeCol: after.datetimeCol, datetimeFormat: after.datetimeFormat,
        dateCol: after.dateCol, dateFormat: after.dateFormat,
        timeCol: after.timeCol, timeFormat: after.timeFormat,
        incomeCol: after.incomeCol, expenseCol: after.expenseCol, amountCol: after.amountCol,
        columns: [after.datetimeCol, after.dateCol, after.timeCol, after.incomeCol, after.expenseCol,
          after.amountCol, after.balanceCol, after.counterpartyNameCol, after.counterpartyAccountCol,
          after.summaryCol, after.noteCol],
      })
      await validateOwnBankAccount(trx, after.companyId, after.bankAccountId, false)
      const changes = auditDiff(templateSnap(before), templateSnap(after), TEMPLATE_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE acc_bank_import_template SET
            name=${after.name},start_row=${after.startRow},
            datetime_col=${after.datetimeCol},datetime_format=${after.datetimeFormat ? lower(after.datetimeFormat) : null},
            date_col=${after.dateCol},date_format=${after.dateFormat ? lower(after.dateFormat) : null},
            time_col=${after.timeCol},time_format=${after.timeFormat ? lower(after.timeFormat) : null},
            income_col=${after.incomeCol},expense_col=${after.expenseCol},amount_col=${after.amountCol},
            balance_col=${after.balanceCol},counterparty_name_col=${after.counterpartyNameCol},
            counterparty_account_col=${after.counterpartyAccountCol},summary_col=${after.summaryCol},
            note_col=${after.noteCol},bank_account_id=${after.bankAccountId}::uuid,
            updated_at=timezone('utc',now()) WHERE id=${id}::uuid
        `.execute(trx)
        const item = await loadTemplate(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import_template', recordId: id, recordLabel: item.name,
          companyId: item.companyId, actionType: 'update', actionName: 'update', changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新流水导入模板失败', WRITE_MAP)
      }
    })
  }

  async function deleteTemplate(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_import_template:delete', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const item = await loadTemplate(trx, id, true)
      requireCompanyAccess(actor, item.companyId, '流水导入模板不存在')
      try {
        await sql`DELETE FROM acc_bank_import_template WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import_template', recordId: id, recordLabel: item.name,
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(templateSnap(item), TEMPLATE_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除流水导入模板失败', WRITE_MAP)
      }
    })
  }

  async function listImports(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankImport[] }
    return listFromSource({
      db, resource: bankImportResourceMeta(),
      source: sql` FROM acc_bank_import`,
      select: sql`SELECT id,status,error,imported_at,inserted_at,updated_at,company_id,bank_account_id,
        template_id,file_id,created_by_id,imported_by_id,
        (SELECT count(*) FROM acc_bank_import_item ii WHERE ii.import_id=acc_bank_import.id) AS item_count,
        (SELECT count(*) FROM acc_bank_import_item ii WHERE ii.import_id=acc_bank_import.id AND ii.error IS NOT NULL) AS error_count`,
      defaultOrder: sql`"id"`, query, extraWhere: scope.where, mapRow: mapImport,
    })
  }

  async function getImport(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    const item = await loadImport(db, id, false)
    requireCompanyAccess(actor, item.companyId, '流水导入记录不存在')
    return item
  }

  async function createImport(actor: Actor, input: {
    companyId: string; bankAccountId: string; templateId: string; fileId: string
  }) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    requirePermission(actor, 'sys.file:read', '无权限执行银行业务操作')
    requireCompanyWrite(actor, input.companyId)
    if (!files) throw new ApiError('internal', '文件读取服务未配置')
    return withTx(db, async (trx) => {
      await validateOwnBankAccount(trx, input.companyId, input.bankAccountId, true)
      let template: BankImportTemplate
      try {
        template = await loadTemplate(trx, input.templateId, false)
      } catch {
        throw validation('流水导入记录', { templateId: ['导入模板不存在'] })
      }
      if (template.companyId !== input.companyId || template.bankAccountId !== input.bankAccountId) {
        throw validation('流水导入记录', { templateId: ['导入模板必须属于所选银行账户'] })
      }
      const fileMeta = await sql<{ sha256: string | null }>`
        SELECT sha256 FROM sys_file WHERE id=${input.fileId}::uuid
      `.execute(trx)
      if (!fileMeta.rows[0]) {
        throw validation('流水导入记录', { fileId: ['导入文件不存在或不可见'] })
      }
      const sha = fileMeta.rows[0].sha256 ?? ''
      if (sha) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.bankAccountId + ':' + sha}, 0))`.execute(trx)
        const dup = await sql<{ e: boolean }>`
          SELECT EXISTS(
            SELECT 1 FROM acc_bank_import i JOIN sys_file f ON f.id=i.file_id
            WHERE i.bank_account_id=${input.bankAccountId}::uuid AND i.status<>'failed' AND f.sha256=${sha}
          ) AS e
        `.execute(trx)
        if (dup.rows[0]?.e) {
          throw validation('流水导入记录', {
            fileId: ['该账户已存在相同文件的导入记录,如需重新导入请先删除原记录'],
          })
        }
      }
      let items: ReturnType<typeof parseBankImport> = []
      let parseMessage: string | null = null
      let status = 'parsed'
      try {
        const { file, content } = await files.readStoredFile(input.fileId)
        if (file.id !== input.fileId) throw new Error('读取存储对象失败,请重新上传文件')
        const parseTpl: ParseTemplate = {
          startRow: template.startRow,
          datetimeCol: template.datetimeCol, datetimeFormat: template.datetimeFormat,
          dateCol: template.dateCol, dateFormat: template.dateFormat,
          timeCol: template.timeCol, timeFormat: template.timeFormat,
          incomeCol: template.incomeCol, expenseCol: template.expenseCol,
          amountCol: template.amountCol, balanceCol: template.balanceCol,
          counterpartyNameCol: template.counterpartyNameCol,
          counterpartyAccountCol: template.counterpartyAccountCol,
          summaryCol: template.summaryCol, noteCol: template.noteCol,
        }
        items = parseBankImport(parseTpl, content, utcOffsetMs)
      } catch (err) {
        status = 'failed'
        parseMessage = truncateRunes(err instanceof Error ? err.message : '读取存储对象失败,请重新上传文件', 500)
        items = []
      }
      try {
        const ins = await sql<{ id: string }>`
          INSERT INTO acc_bank_import(status,error,company_id,bank_account_id,template_id,file_id,created_by_id)
          VALUES (${status},${parseMessage},${input.companyId}::uuid,${input.bankAccountId}::uuid,
            ${input.templateId}::uuid,${input.fileId}::uuid,${actorUserId(actor)}::uuid)
          RETURNING id
        `.execute(trx)
        const importId = ins.rows[0]!.id
        for (const parsed of items) {
          await sql`
            INSERT INTO acc_bank_import_item(
              row_no,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
              summary,note,error,import_id,company_id)
            VALUES (
              ${parsed.rowNo},${parsed.occurredAt?.toISOString() ?? null}::timestamptz,
              ${parsed.income},${parsed.expense},${parsed.balance},${parsed.counterpartyName},
              ${parsed.counterpartyAccount},${parsed.summary},${parsed.note},${parsed.error},
              ${importId}::uuid,${input.companyId}::uuid)
          `.execute(trx)
        }
        const item = await loadImport(trx, importId, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import', recordId: item.id, recordLabel: item.id,
          companyId: item.companyId, actionType: 'create', actionName: 'create',
          changes: auditCreated(importSnap(item), IMPORT_AUDIT),
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '创建流水导入记录失败', WRITE_MAP)
      }
    })
  }

  async function runImport(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    requirePermission(actor, 'acc.bank_transaction:create', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const before = await loadImport(trx, id, true)
      requireCompanyAccess(actor, before.companyId, '流水导入记录不存在')
      if (before.status !== 'PARSED') throw conflict('仅「已解析」状态的导入记录可执行导入')
      const itemRows = await sql<Record<string, unknown>>`
        SELECT id,row_no,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
          summary,note,error,inserted_at,updated_at,import_id,company_id,transaction_id
        FROM acc_bank_import_item WHERE import_id=${id}::uuid ORDER BY row_no,id FOR UPDATE
      `.execute(trx)
      const items = itemRows.rows.map(mapItem)
      if (items.length === 0) throw validation('流水导入记录', { items: ['没有可导入的行'] })
      const badRows: string[] = []
      let errorCount = 0
      for (const it of items) {
        if (it.error) {
          errorCount++
          if (badRows.length < 5) badRows.push(String(it.rowNo))
        }
      }
      if (errorCount > 0) {
        const suffix = errorCount > 5 ? ' 等' : ''
        throw validation('流水导入记录', {
          items: [`存在 ${errorCount} 行错误(第 ${badRows.join('、')} 行${suffix}),修正或删除后才能导入`],
        })
      }
      for (const staged of items) {
        try {
          const created = await deps.createTransactionInTx(trx, actor, {
            occurredAt: staged.occurredAt ?? '',
            income: staged.income, expense: staged.expense, balance: staged.balance,
            counterpartyName: staged.counterpartyName, counterpartyAccount: staged.counterpartyAccount,
            summary: staged.summary, note: staged.note,
            companyId: before.companyId, bankAccountId: before.bankAccountId,
          }, true)
          await sql`
            UPDATE acc_bank_import_item SET transaction_id=${created.id}::uuid, updated_at=timezone('utc',now())
            WHERE id=${staged.id}::uuid
          `.execute(trx)
          const linked = { ...staged, transactionId: created.id }
          await writeAudit(trx, actor, {
            resource: 'acc_bank_import_item', recordId: staged.id,
            recordLabel: `${staged.importId}#${staged.rowNo}`,
            companyId: staged.companyId, actionType: 'update', actionName: 'link_transaction',
            changes: auditDiff(itemSnap(staged), itemSnap(linked), ITEM_AUDIT),
          })
        } catch (err) {
          if (err instanceof ApiError) {
            throw new ApiError('validation', `第 ${staged.rowNo} 行导入失败`, { cause: err })
          }
          throw err
        }
      }
      await sql`
        UPDATE acc_bank_import SET status='imported', imported_at=timezone('utc',now()),
          imported_by_id=${actorUserId(actor)}::uuid, updated_at=timezone('utc',now())
        WHERE id=${id}::uuid
      `.execute(trx)
      const after = await loadImport(trx, id, false)
      await writeAudit(trx, actor, {
        resource: 'acc_bank_import', recordId: id, recordLabel: after.id,
        companyId: after.companyId, actionType: 'update', actionName: 'import',
        changes: auditDiff(importSnap(before), importSnap(after), IMPORT_AUDIT),
      })
      return after
    })
  }

  async function deleteImport(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const item = await loadImport(trx, id, true)
      requireCompanyAccess(actor, item.companyId, '流水导入记录不存在')
      if (item.status === 'IMPORTED') throw conflict('已导入的记录不可删除')
      try {
        await sql`DELETE FROM acc_bank_import WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import', recordId: id, recordLabel: item.id,
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(importSnap(item), IMPORT_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除流水导入记录失败', WRITE_MAP)
      }
    })
  }

  async function listItems(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    const scope = companyScopeWhere(actor)
    if (scope.empty) return { count: 0, results: [] as BankImportItem[] }
    return listFromSource({
      db, resource: bankImportItemResourceMeta(),
      source: sql` FROM acc_bank_import_item`,
      select: sql`SELECT id,row_no,occurred_at,income,expense,balance,counterparty_name,
        counterparty_account,summary,note,error,inserted_at,updated_at,import_id,company_id,transaction_id`,
      defaultOrder: sql`"row_no","id"`, query, extraWhere: scope.where, mapRow: mapItem,
    })
  }

  async function getItem(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    const item = await loadItem(db, id, false)
    requireCompanyAccess(actor, item.companyId, '流水导入行不存在')
    return item
  }

  async function lockParsedImport(trx: DbHandle, importId: string) {
    const rows = await sql<{ status: string }>`
      SELECT status FROM acc_bank_import WHERE id=${importId}::uuid FOR UPDATE
    `.execute(trx)
    if (!rows.rows[0]) throw notFound('流水导入记录')
    if (upper(rows.rows[0].status) !== 'PARSED') {
      throw conflict('仅「已解析」状态的导入记录可编辑或删除行')
    }
  }

  async function updateItem(actor: Actor, id: string, input: {
    occurredAt?: string
    income?: string | null; incomePresent?: boolean
    expense?: string | null; expensePresent?: boolean
    balance?: string | null; balancePresent?: boolean
    counterpartyName?: string | null; counterpartyNamePresent?: boolean
    counterpartyAccount?: string | null; counterpartyAccountPresent?: boolean
    summary?: string | null; summaryPresent?: boolean
    note?: string | null; notePresent?: boolean
  }) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const seed = await loadItem(trx, id, false)
      await lockParsedImport(trx, seed.importId)
      const before = await loadItem(trx, id, true)
      if (before.importId !== seed.importId) throw conflict('流水导入行已被并发修改')
      requireCompanyAccess(actor, before.companyId, '流水导入行不存在')
      const after = { ...before }
      if (input.occurredAt !== undefined) after.occurredAt = new Date(input.occurredAt).toISOString()
      if (input.incomePresent) after.income = input.income ?? null
      if (input.expensePresent) after.expense = input.expense ?? null
      if (input.balancePresent) after.balance = input.balance ?? null
      if (input.counterpartyNamePresent) after.counterpartyName = input.counterpartyName ?? null
      if (input.counterpartyAccountPresent) after.counterpartyAccount = input.counterpartyAccount ?? null
      if (input.summaryPresent) after.summary = input.summary ?? null
      if (input.notePresent) after.note = input.note ?? null
      validateTxnShape(
        after.occurredAt ?? '', after.income, after.expense,
        after.counterpartyName, after.counterpartyAccount, after.summary, after.note,
      )
      after.error = null
      const changes = auditDiff(itemSnap(before), itemSnap(after), ITEM_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await sql`
          UPDATE acc_bank_import_item SET
            occurred_at=${after.occurredAt}::timestamptz,income=${after.income},expense=${after.expense},
            balance=${after.balance},counterparty_name=${after.counterpartyName},
            counterparty_account=${after.counterpartyAccount},summary=${after.summary},note=${after.note},
            error=NULL,updated_at=timezone('utc',now()) WHERE id=${id}::uuid
        `.execute(trx)
        const item = await loadItem(trx, id, false)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import_item', recordId: id,
          recordLabel: `${item.importId}#${item.rowNo}`,
          companyId: item.companyId, actionType: 'update', actionName: 'update', changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新流水导入行失败', WRITE_MAP)
      }
    })
  }

  async function deleteItem(actor: Actor, id: string) {
    requirePermission(actor, 'acc.bank_transaction:import', '无权限执行银行业务操作')
    return withTx(db, async (trx) => {
      const seed = await loadItem(trx, id, false)
      await lockParsedImport(trx, seed.importId)
      const item = await loadItem(trx, id, true)
      requireCompanyAccess(actor, item.companyId, '流水导入行不存在')
      try {
        await sql`DELETE FROM acc_bank_import_item WHERE id=${id}::uuid`.execute(trx)
        await writeAudit(trx, actor, {
          resource: 'acc_bank_import_item', recordId: id,
          recordLabel: `${item.importId}#${item.rowNo}`,
          companyId: item.companyId, actionType: 'destroy', actionName: 'destroy',
          changes: auditDestroyed(itemSnap(item), ITEM_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除流水导入行失败', WRITE_MAP)
      }
    })
  }

  return {
    listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
    listImports, getImport, createImport, runImport, deleteImport,
    listItems, getItem, updateItem, deleteItem,
  }
}
