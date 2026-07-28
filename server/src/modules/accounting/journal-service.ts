/**
 * 手工会计凭证（头 + 行）服务。
 * 审核/取消经 GL 引擎写分录；禁止直写 acc_gl_entry。
 */
import { decimal, isDecimalString, type Decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle, type TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import {
  canAccessCompany,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { companyScopeWhere, listFromSource } from '~/db/list.ts'
import { journalLineResourceMeta, journalResourceMeta } from './meta.ts'

export type JournalStatus = 'DRAFT' | 'AUDITED' | 'CANCELLED'

export interface NamedRef {
  id: string
  name: string
}

export interface CodeNamedRef {
  id: string
  code: string
  name: string
}

export interface JournalRef {
  id: string
  voucherNo: string
}

export interface Journal {
  id: string
  voucherNo: string
  date: string
  postingDate: string | null
  remarks: string | null
  status: JournalStatus
  submittedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  createdById: string | null
  submittedById: string | null
  debitTotal: string
  creditTotal: string
  company: NamedRef
  createdBy: NamedRef | null
  submittedBy: NamedRef | null
}

export interface JournalLine {
  id: string
  idx: number
  debit: string
  credit: string
  partyType: string | null
  partyId: string | null
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  journalId: string
  companyId: string
  accountId: string
  currencyId: string | null
  journal: JournalRef
  company: NamedRef
  account: CodeNamedRef
  currency: CodeNamedRef | null
}

export interface CreateJournalInput {
  voucherNo?: string | null
  date: string
  postingDate?: string | null
  remarks?: string | null
  companyId: string
}

/** createAndAuditJournal 的行入参（金额 Decimal 或十进制字符串） */
export interface CreateAndAuditLineInput {
  accountId: string
  debit: Decimal | string
  credit: Decimal | string
  partyType?: string | null
  partyId?: string | null
  remarks?: string | null
}

/**
 * 内部 seam 入参：同一 trx 内「建凭证 + 审核过账」。
 * 供银行对账等系统侧生成凭证的场景；无权限闸（调用方已鉴权）。
 */
export interface CreateAndAuditJournalInput {
  companyId: string
  /** 凭证日期 */
  date: string
  /** 过账日期（审核即过账） */
  postingDate: string
  remarks?: string | null
  lines: CreateAndAuditLineInput[]
}

export interface UpdateJournalInput {
  voucherNo?: string
  date?: string
  postingDate?: string | null
  postingDatePresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface CreateLineInput {
  journalId: string
  idx: number
  accountId: string
  debit: string
  credit: string
  partyType?: string | null
  partyId?: string | null
  remarks?: string | null
}

export interface UpdateLineInput {
  idx?: number
  accountId?: string
  debit?: string
  credit?: string
  partyType?: string | null
  partyTypePresent?: boolean
  partyId?: string | null
  partyIdPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

const JOURNAL_AUDIT = [
  'voucher_no',
  'date',
  'posting_date',
  'remarks',
  'status',
  'submitted_at',
  'company_id',
  'created_by_id',
  'submitted_by_id',
] as const

const LINE_AUDIT = [
  'idx',
  'debit',
  'credit',
  'party_type',
  'party_id',
  'remarks',
  'journal_id',
  'company_id',
  'account_id',
  'currency_id',
] as const

const PARTY_KINDS = new Set(['supplier', 'customer', 'company', 'employee'])
const VOUCHER_TYPE = 'acc.gl_journal'

const JOURNAL_SOURCE = sql`
 FROM (
SELECT j.id, j.voucher_no, j.date, j.posting_date, j.remarks, j.status,
  j.submitted_at, j.inserted_at, j.updated_at, j.company_id, j.created_by_id,
  j.submitted_by_id,
  COALESCE(sum(l.debit), 0)::numeric AS debit_total,
  COALESCE(sum(l.credit), 0)::numeric AS credit_total,
  c.name AS company_name, creator.name AS created_by_name,
  submitter.name AS submitted_by_name
FROM acc_gl_journal j
JOIN bas_company c ON c.id = j.company_id
LEFT JOIN sys_user creator ON creator.id = j.created_by_id
LEFT JOIN sys_user submitter ON submitter.id = j.submitted_by_id
LEFT JOIN acc_gl_journal_line l ON l.journal_id = j.id
GROUP BY j.id, c.name, creator.name, submitter.name
) AS journals`

const LINE_SOURCE = sql`
 FROM (
SELECT l.id, l.idx, l.debit, l.credit, l.party_type, l.party_id, l.remarks,
  l.inserted_at, l.updated_at, l.journal_id, l.company_id, l.account_id,
  l.currency_id, j.voucher_no, c.name AS company_name, a.code AS account_code,
  a.name AS account_name, cur.iso_code AS currency_code, cur.name AS currency_name
FROM acc_gl_journal_line l
JOIN acc_gl_journal j ON j.id = l.journal_id
JOIN bas_company c ON c.id = l.company_id
JOIN bas_account a ON a.id = l.account_id
LEFT JOIN bas_currency cur ON cur.id = l.currency_id
) AS journal_lines`

const WRITE_MAPPINGS = [
  { code: '23505', message: '同一公司内凭证编号必须唯一' },
  { code: '23503', message: '会计凭证参数不合法' },
] as const

export type JournalService = ReturnType<typeof createJournalService>

export function createJournalService(
  db: Kysely<Database>,
  numbering: NumberingService,
  gl: GlEngine,
) {
  async function get(actor: Actor, id: string): Promise<Journal> {
    requireAction(actor, 'read')
    const item = await loadJournal(db, id)
    if (!canAccessCompany(actor, item.companyId)) throw notFound()
    return item
  }

  async function list(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: Journal[] }> {
    requireAction(actor, 'read')
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] }

    const { ordinaryFilter, lineFilter } = splitJournalLineFilter(query.filter)
    const extras: ReturnType<typeof sql>[] = []
    if (scope.where) extras.push(scope.where)
    if (lineFilter) {
      extras.push(sql`EXISTS (
        SELECT 1 FROM acc_gl_journal_line lf
        WHERE lf.journal_id = journals.id
          AND lf.account_id = ${lineFilter.accountId}::uuid
          AND lf.${sql.raw(lineFilter.side)} > ${lineFilter.amount}
      )`)
    }
    const extraWhere =
      extras.length === 0
        ? null
        : extras.length === 1
          ? extras[0]!
          : sql`${sql.join(extras, sql` AND `)}`

    return listFromSource({
      db,
      resource: journalResourceMeta(),
      source: JOURNAL_SOURCE,
      select: sql`SELECT id, voucher_no, date, posting_date, remarks, status,
submitted_at, inserted_at, updated_at, company_id, created_by_id, submitted_by_id,
debit_total, credit_total, company_name, created_by_name, submitted_by_name`,
      defaultOrder: sql`"date" DESC, "voucher_no" ASC, "id" ASC`,
      query: { ...query, filter: ordinaryFilter },
      extraWhere,
      mapRow: (r) => mapJournalRow(r),
    })
  }

  async function create(actor: Actor, input: CreateJournalInput): Promise<Journal> {
    requireAction(actor, 'create')
    if (!canAccessCompany(actor, input.companyId)) {
      throw new ApiError('forbidden', '无权操作该公司数据')
    }
    return withTx(db, (trx) => createJournalInTx(trx, actor, input))
  }

  /** 建头（编号→插入→审计）。create 与 createAndAuditJournal 共用的唯一实现。 */
  async function createJournalInTx(
    trx: TrxHandle,
    actor: Actor,
    input: CreateJournalInput,
  ): Promise<Journal> {
    validateCreate(input)
    let voucherNo = (input.voucherNo ?? '').trim()
    if (voucherNo === '') {
      voucherNo = await numbering.nextInTx(trx, {
        resource: 'acc.gl_journal',
        values: { company_id: input.companyId, date: input.date },
      })
    }
    if ([...voucherNo].length > 32) {
      throw validation('voucherNo', '最多 32 个字符')
    }
    try {
      const inserted = await trx
        .insertInto('acc_gl_journal')
        .values({
          voucher_no: voucherNo,
          date: input.date,
          posting_date: input.postingDate ?? null,
          remarks: emptyToNull(input.remarks),
          company_id: input.companyId,
          created_by_id: actorUserId(actor),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const item = await loadJournal(trx, inserted.id)
      await writeAudit(trx, actor, {
        resource: 'acc_gl_journal',
        recordId: item.id,
        recordLabel: item.voucherNo,
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(journalSnap(item), JOURNAL_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建会计凭证失败', WRITE_MAPPINGS)
    }
  }

  async function update(
    actor: Actor,
    id: string,
    input: UpdateJournalInput,
  ): Promise<Journal> {
    requireAction(actor, 'update')
    return withTx(db, async (trx) => {
      const locked = await lockJournal(trx, id)
      if (!canAccessCompany(actor, locked.company_id)) throw notFound()
      if (locked.status !== 'draft') throw draftError()
      const before = await loadJournal(trx, id)
      const after: Journal = {
        ...before,
        voucherNo: input.voucherNo !== undefined ? input.voucherNo.trim() : before.voucherNo,
        date: input.date ?? before.date,
        postingDate: input.postingDatePresent
          ? (input.postingDate ?? null)
          : before.postingDate,
        remarks: input.remarksPresent ? (input.remarks ?? null) : before.remarks,
      }
      validateMutable(after)
      const changes = auditDiff(journalSnap(before), journalSnap(after), JOURNAL_AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await trx
          .updateTable('acc_gl_journal')
          .set({
            voucher_no: after.voucherNo,
            date: after.date,
            posting_date: after.postingDate,
            remarks: after.remarks,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
        const item = await loadJournal(trx, id)
        await writeAudit(trx, actor, {
          resource: 'acc_gl_journal',
          recordId: item.id,
          recordLabel: item.voucherNo,
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新会计凭证失败', WRITE_MAPPINGS)
      }
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requireAction(actor, 'delete')
    await withTx(db, async (trx) => {
      const locked = await lockJournal(trx, id)
      if (!canAccessCompany(actor, locked.company_id)) throw notFound()
      if (locked.status !== 'draft') throw draftError()
      const before = await loadJournal(trx, id)
      try {
        await trx.deleteFrom('acc_gl_journal').where('id', '=', id).execute()
        await writeAudit(trx, actor, {
          resource: 'acc_gl_journal',
          recordId: before.id,
          recordLabel: before.voucherNo,
          companyId: before.companyId,
          actionType: 'destroy',
          actionName: 'destroy',
          changes: auditDestroyed(journalSnap(before), JOURNAL_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除会计凭证失败', WRITE_MAPPINGS)
      }
    })
  }

  async function audit(
    actor: Actor,
    id: string,
    postingDate?: string | null,
  ): Promise<Journal> {
    requireAction(actor, 'audit')
    return withTx(db, (trx) => auditJournalInTx(trx, actor, id, postingDate))
  }

  /** 审核过账（锁头→复核行→GL→状态翻转→审计）。audit 与 createAndAuditJournal 共用的唯一实现。 */
  async function auditJournalInTx(
    trx: TrxHandle,
    actor: Actor,
    id: string,
    postingDate?: string | null,
  ): Promise<Journal> {
    const locked = await lockJournal(trx, id)
    if (!canAccessCompany(actor, locked.company_id)) throw notFound()
    if (locked.status !== 'draft') {
      throw new ApiError('conflict', '仅草稿凭证可审核')
    }
    const effectiveDate =
      postingDate && postingDate.trim() !== ''
        ? postingDate.trim().slice(0, 10)
        : locked.posting_date
          ? dateOnly(locked.posting_date)
          : null
    if (!effectiveDate) {
      throw validation('postingDate', '审核过账前必须填写过账日期')
    }

    const lineRows = await trx
      .selectFrom('acc_gl_journal_line')
      .selectAll()
      .where('journal_id', '=', id)
      .orderBy('idx', 'asc')
      .orderBy('id', 'asc')
      .execute()

    const entries: GlEntry[] = []
    for (const row of lineRows) {
      const line = {
        idx: Number(row.idx),
        accountId: row.account_id,
        debit: decimal(String(row.debit)),
        credit: decimal(String(row.credit)),
        partyType: row.party_type ? row.party_type.toUpperCase() : null,
        partyId: row.party_id,
        remarks: row.remarks,
        currencyId: row.currency_id,
      }
      await validatePersistedLine(trx, locked.company_id, line)
      entries.push({
        accountId: line.accountId,
        currencyId: line.currencyId,
        debit: line.debit,
        credit: line.credit,
        partyType: line.partyType ? line.partyType.toLowerCase() : null,
        partyId: line.partyId,
        remarks: line.remarks,
      })
    }

    const before = await loadJournal(trx, id)
    await gl.post(trx, {
      type: VOUCHER_TYPE,
      id,
      no: locked.voucher_no,
      companyId: locked.company_id,
      postingDate: effectiveDate,
    }, entries)

    const now = new Date()
    await trx
      .updateTable('acc_gl_journal')
      .set({
        status: 'audited',
        posting_date: effectiveDate,
        submitted_at: now,
        submitted_by_id: actorUserId(actor),
        updated_at: sql`(now() AT TIME ZONE 'utc')`,
      })
      .where('id', '=', id)
      .execute()

    const after = await loadJournal(trx, id)
    await writeAudit(trx, actor, {
      resource: 'acc_gl_journal',
      recordId: after.id,
      recordLabel: after.voucherNo,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'audit',
      changes: auditDiff(journalSnap(before), journalSnap(after), JOURNAL_AUDIT),
    })
    return after
  }

  async function cancel(actor: Actor, id: string): Promise<Journal> {
    requireAction(actor, 'cancel')
    return withTx(db, async (trx) => {
      const locked = await lockJournal(trx, id)
      if (!canAccessCompany(actor, locked.company_id)) throw notFound()
      if (locked.status !== 'audited') {
        throw new ApiError('conflict', '仅已审核凭证可取消')
      }
      const used = await trx
        .selectFrom('acc_bank_reconciliation')
        .select('id')
        .where('journal_id', '=', id)
        .executeTakeFirst()
      if (used) {
        throw new ApiError('conflict', '凭证已用于银行对账,请先解除对账')
      }
      const before = await loadJournal(trx, id)
      await gl.cancel(trx, { type: VOUCHER_TYPE, id })
      await trx
        .updateTable('acc_gl_journal')
        .set({
          status: 'cancelled',
          updated_at: sql`(now() AT TIME ZONE 'utc')`,
        })
        .where('id', '=', id)
        .execute()
      const after = await loadJournal(trx, id)
      await writeAudit(trx, actor, {
        resource: 'acc_gl_journal',
        recordId: after.id,
        recordLabel: after.voucherNo,
        companyId: after.companyId,
        actionType: 'update',
        actionName: 'cancel',
        changes: auditDiff(journalSnap(before), journalSnap(after), JOURNAL_AUDIT),
      })
      return after
    })
  }

  async function getLine(actor: Actor, id: string): Promise<JournalLine> {
    requireAction(actor, 'read')
    const item = await loadLine(db, id)
    if (!canAccessCompany(actor, item.companyId)) throw lineNotFound()
    return item
  }

  async function listLines(
    actor: Actor,
    query: Partial<ListQuery>,
  ): Promise<{ count: number; results: JournalLine[] }> {
    requireAction(actor, 'read')
    const scope = companyScopeWhere(actor, 'company_id')
    if (scope.empty) return { count: 0, results: [] }
    return listFromSource({
      db,
      resource: journalLineResourceMeta(),
      source: LINE_SOURCE,
      select: sql`SELECT id, idx, debit, credit, party_type, party_id, remarks,
inserted_at, updated_at, journal_id, company_id, account_id, currency_id,
voucher_no, company_name, account_code, account_name, currency_code, currency_name`,
      defaultOrder: sql`"idx" ASC, "id" ASC`,
      query,
      extraWhere: scope.where,
      mapRow: (r) => mapLineRow(r),
    })
  }

  async function createLine(actor: Actor, input: CreateLineInput): Promise<JournalLine> {
    requireAction(actor, 'create')
    return withTx(db, async (trx) => {
      const journal = await lockDraftJournal(trx, actor, input.journalId)
      return insertLineInTx(trx, actor, journal, input)
    })
  }

  /** 建行（形状/引用校验→插入→审计）。createLine 与 createAndAuditJournal 共用的唯一实现。 */
  async function insertLineInTx(
    trx: TrxHandle,
    actor: Actor,
    journal: { id: string; company_id: string },
    input: CreateLineInput,
  ): Promise<JournalLine> {
    const debit = parseAmount(input.debit, 'debit')
    const credit = parseAmount(input.credit, 'credit')
    validateLineShape(
      input.idx,
      input.accountId,
      debit,
      credit,
      input.partyType ?? null,
      input.partyId ?? null,
      input.remarks ?? null,
    )
    const currencyId = await validateLineReferences(
      trx,
      journal.company_id,
      input.accountId,
      input.partyType ?? null,
      input.partyId ?? null,
    )
    try {
      const inserted = await trx
        .insertInto('acc_gl_journal_line')
        .values({
          idx: input.idx,
          debit: debit.toFixed(),
          credit: credit.toFixed(),
          party_type: normalizePartyDb(input.partyType ?? null),
          party_id: input.partyId ?? null,
          remarks: emptyToNull(input.remarks),
          journal_id: journal.id,
          company_id: journal.company_id,
          account_id: input.accountId,
          currency_id: currencyId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const item = await loadLine(trx, inserted.id)
      await writeAudit(trx, actor, {
        resource: 'acc_gl_journal_line',
        recordId: item.id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(lineSnap(item), LINE_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建会计凭证行失败', WRITE_MAPPINGS)
    }
  }

  async function updateLine(
    actor: Actor,
    id: string,
    input: UpdateLineInput,
  ): Promise<JournalLine> {
    requireAction(actor, 'update')
    return withTx(db, async (trx) => {
      const current = await trx
        .selectFrom('acc_gl_journal_line')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw lineNotFound()
      if (!canAccessCompany(actor, current.company_id)) throw lineNotFound()
      await lockDraftJournal(trx, actor, current.journal_id)
      const locked = await trx
        .selectFrom('acc_gl_journal_line')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw lineNotFound()

      const before = await loadLine(trx, id)
      const debit =
        input.debit !== undefined ? parseAmount(input.debit, 'debit') : decimal(before.debit)
      const credit =
        input.credit !== undefined ? parseAmount(input.credit, 'credit') : decimal(before.credit)
      const partyType = input.partyTypePresent
        ? (input.partyType ?? null)
        : before.partyType
      const partyId = input.partyIdPresent ? (input.partyId ?? null) : before.partyId
      const remarks = input.remarksPresent ? (input.remarks ?? null) : before.remarks
      const idx = input.idx ?? before.idx
      const accountId = input.accountId ?? before.accountId

      validateLineShape(idx, accountId, debit, credit, partyType, partyId, remarks)
      const currencyId = await validateLineReferences(
        trx,
        locked.company_id,
        accountId,
        partyType,
        partyId,
      )

      const afterPreview: JournalLine = {
        ...before,
        idx,
        debit: debit.toFixed(),
        credit: credit.toFixed(),
        partyType: partyType ? partyType.toUpperCase() : null,
        partyId,
        remarks,
        accountId,
        currencyId,
      }
      const changes = auditDiff(lineSnap(before), lineSnap(afterPreview), LINE_AUDIT)
      if (Object.keys(changes).length === 0) return before

      try {
        await trx
          .updateTable('acc_gl_journal_line')
          .set({
            idx,
            debit: debit.toFixed(),
            credit: credit.toFixed(),
            party_type: normalizePartyDb(partyType),
            party_id: partyId,
            remarks,
            account_id: accountId,
            currency_id: currencyId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
        const item = await loadLine(trx, id)
        await writeAudit(trx, actor, {
          resource: 'acc_gl_journal_line',
          recordId: item.id,
          recordLabel: String(item.idx),
          companyId: item.companyId,
          actionType: 'update',
          actionName: 'update',
          changes,
        })
        return item
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '更新会计凭证行失败', WRITE_MAPPINGS)
      }
    })
  }

  async function removeLine(actor: Actor, id: string): Promise<void> {
    requireAction(actor, 'delete')
    await withTx(db, async (trx) => {
      const current = await trx
        .selectFrom('acc_gl_journal_line')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (!current) throw lineNotFound()
      if (!canAccessCompany(actor, current.company_id)) throw lineNotFound()
      await lockDraftJournal(trx, actor, current.journal_id)
      const locked = await trx
        .selectFrom('acc_gl_journal_line')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw lineNotFound()
      const before = await loadLine(trx, id)
      try {
        await trx.deleteFrom('acc_gl_journal_line').where('id', '=', id).execute()
        await writeAudit(trx, actor, {
          resource: 'acc_gl_journal_line',
          recordId: before.id,
          recordLabel: String(before.idx),
          companyId: before.companyId,
          actionType: 'destroy',
          actionName: 'destroy',
          changes: auditDestroyed(lineSnap(before), LINE_AUDIT),
        })
      } catch (err) {
        if (err instanceof ApiError) throw err
        throw mapWriteError(err, '删除会计凭证行失败', WRITE_MAPPINGS)
      }
    })
  }

  /**
   * 内部 seam：调用方 trx 内一气呵成立凭证并审核过账。
   * 凭证生命周期（编号→头→行→GL→状态翻转→审计）只有本模块一份实现；
   * 不设权限闸——调用方（如银行对账）已用自己的权限码鉴权。
   */
  async function createAndAuditJournal(
    trx: TrxHandle,
    actor: Actor,
    input: CreateAndAuditJournalInput,
  ): Promise<Journal> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw ApiError.validation('会计凭证参数不合法', { lines: ['至少一行'] })
    }
    const journal = await createJournalInTx(trx, actor, {
      companyId: input.companyId,
      date: input.date,
      postingDate: input.postingDate,
      remarks: input.remarks ?? null,
    })
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!
      await insertLineInTx(trx, actor, { id: journal.id, company_id: journal.companyId }, {
        journalId: journal.id,
        idx: i + 1,
        accountId: line.accountId,
        debit: typeof line.debit === 'string' ? line.debit : line.debit.toFixed(),
        credit: typeof line.credit === 'string' ? line.credit : line.credit.toFixed(),
        partyType: line.partyType ?? null,
        partyId: line.partyId ?? null,
        remarks: line.remarks ?? null,
      })
    }
    return auditJournalInTx(trx, actor, journal.id, input.postingDate)
  }

  return {
    get,
    list,
    create,
    update,
    remove,
    audit,
    cancel,
    createAndAuditJournal,
    getLine,
    listLines,
    createLine,
    updateLine,
    removeLine,
  }
}

// ─── helpers ───────────────────────────────────────────────

function requireAction(actor: Actor | null, action: string): asserts actor is Actor {
  if (!hasPermission(actor, `acc.gl_journal:${action}`)) {
    throw new ApiError('forbidden', '无权执行会计凭证操作')
  }
}

/** 仅真实 UUID 写入 created_by/submitted_by；空串/非法值 → null（对齐 Go uuid.Nil） */
function actorUserId(actor: Actor): string | null {
  const id = actor.userId?.trim() ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null
}

function notFound(): ApiError {
  return new ApiError('not_found', '会计凭证不存在')
}

function lineNotFound(): ApiError {
  return new ApiError('not_found', '会计凭证行不存在')
}

function draftError(): ApiError {
  return new ApiError('conflict', '仅草稿凭证可修改或删除')
}

function validation(field: string, message: string): ApiError {
  return ApiError.validation('会计凭证参数不合法', { [field]: [message] })
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return value
}

function dateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.trim().slice(0, 10)
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  return new Date(String(value))
}

function decStr(value: unknown): string {
  return decimal(String(value ?? 0)).toFixed()
}

function parseAmount(raw: string, field: string) {
  if (!isDecimalString(raw)) {
    throw ApiError.validation('会计凭证行参数不合法', { [field]: ['必须是十进制字符串'] })
  }
  return decimal(raw)
}

function normalizePartyDb(partyType: string | null): string | null {
  if (!partyType) return null
  return partyType.trim().toLowerCase()
}

async function lockJournal(db: DbHandle, id: string) {
  const row = await db
    .selectFrom('acc_gl_journal')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound()
  return row
}

async function lockDraftJournal(db: DbHandle, actor: Actor, journalId: string) {
  const row = await lockJournal(db, journalId)
  if (!canAccessCompany(actor, row.company_id)) throw notFound()
  if (row.status !== 'draft') {
    throw new ApiError('conflict', '仅草稿凭证可编辑分录行')
  }
  return row
}

async function loadJournal(db: DbHandle, id: string): Promise<Journal> {
  const result = await sql<Record<string, unknown>>`
    SELECT id, voucher_no, date, posting_date, remarks, status,
      submitted_at, inserted_at, updated_at, company_id, created_by_id, submitted_by_id,
      debit_total, credit_total, company_name, created_by_name, submitted_by_name
    ${JOURNAL_SOURCE}
    WHERE id = ${id}
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw notFound()
  return mapJournalRow(row)
}

async function loadLine(db: DbHandle, id: string): Promise<JournalLine> {
  const result = await sql<Record<string, unknown>>`
    SELECT id, idx, debit, credit, party_type, party_id, remarks,
      inserted_at, updated_at, journal_id, company_id, account_id, currency_id,
      voucher_no, company_name, account_code, account_name, currency_code, currency_name
    ${LINE_SOURCE}
    WHERE id = ${id}
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw lineNotFound()
  return mapLineRow(row)
}

function mapJournalRow(r: Record<string, unknown>): Journal {
  const companyId = String(r.company_id)
  const createdById = r.created_by_id == null ? null : String(r.created_by_id)
  const submittedById = r.submitted_by_id == null ? null : String(r.submitted_by_id)
  return {
    id: String(r.id),
    voucherNo: String(r.voucher_no),
    date: dateOnly(r.date as Date | string),
    postingDate: r.posting_date == null ? null : dateOnly(r.posting_date as Date | string),
    remarks: r.remarks == null ? null : String(r.remarks),
    status: String(r.status).toUpperCase() as JournalStatus,
    submittedAt: r.submitted_at == null ? null : toDate(r.submitted_at),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    companyId,
    createdById,
    submittedById,
    debitTotal: decStr(r.debit_total),
    creditTotal: decStr(r.credit_total),
    company: { id: companyId, name: String(r.company_name) },
    createdBy:
      createdById && r.created_by_name != null
        ? { id: createdById, name: String(r.created_by_name) }
        : null,
    submittedBy:
      submittedById && r.submitted_by_name != null
        ? { id: submittedById, name: String(r.submitted_by_name) }
        : null,
  }
}

function mapLineRow(r: Record<string, unknown>): JournalLine {
  const id = String(r.id)
  const journalId = String(r.journal_id)
  const companyId = String(r.company_id)
  const accountId = String(r.account_id)
  const currencyId = r.currency_id == null ? null : String(r.currency_id)
  const partyType = r.party_type == null ? null : String(r.party_type).toUpperCase()
  return {
    id,
    idx: Number(r.idx),
    debit: decStr(r.debit),
    credit: decStr(r.credit),
    partyType,
    partyId: r.party_id == null ? null : String(r.party_id),
    remarks: r.remarks == null ? null : String(r.remarks),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    journalId,
    companyId,
    accountId,
    currencyId,
    journal: { id: journalId, voucherNo: String(r.voucher_no) },
    company: { id: companyId, name: String(r.company_name) },
    account: {
      id: accountId,
      code: String(r.account_code),
      name: String(r.account_name),
    },
    currency:
      currencyId == null
        ? null
        : {
            id: currencyId,
            code: String(r.currency_code ?? ''),
            name: String(r.currency_name ?? ''),
          },
  }
}

function journalSnap(item: Journal): Record<string, unknown> {
  return {
    voucher_no: item.voucherNo,
    date: item.date,
    posting_date: item.postingDate,
    remarks: item.remarks,
    status: item.status,
    submitted_at: item.submittedAt,
    company_id: item.companyId,
    created_by_id: item.createdById,
    submitted_by_id: item.submittedById,
  }
}

function lineSnap(item: JournalLine): Record<string, unknown> {
  return {
    idx: item.idx,
    debit: item.debit,
    credit: item.credit,
    party_type: item.partyType,
    party_id: item.partyId,
    remarks: item.remarks,
    journal_id: item.journalId,
    company_id: item.companyId,
    account_id: item.accountId,
    currency_id: item.currencyId,
  }
}

function validateCreate(input: CreateJournalInput): void {
  const fields: Record<string, string[]> = {}
  if (!input.companyId) fields.companyId = ['必填']
  if (!input.date || input.date.trim() === '') fields.date = ['必填']
  if (input.voucherNo != null && [...input.voucherNo.trim()].length > 32) {
    fields.voucherNo = ['最多 32 个字符']
  }
  if (input.remarks != null && [...input.remarks].length > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('会计凭证参数不合法', fields)
  }
}

function validateMutable(item: Journal): void {
  const fields: Record<string, string[]> = {}
  if (!item.voucherNo.trim()) fields.voucherNo = ['必填']
  else if ([...item.voucherNo].length > 32) fields.voucherNo = ['最多 32 个字符']
  if (!item.date) fields.date = ['必填']
  if (item.remarks != null && [...item.remarks].length > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('会计凭证参数不合法', fields)
  }
}

function validateLineShape(
  idx: number,
  accountId: string,
  debit: ReturnType<typeof decimal>,
  credit: ReturnType<typeof decimal>,
  partyType: string | null,
  partyId: string | null,
  remarks: string | null,
): void {
  const fields: Record<string, string[]> = {}
  if (!accountId) fields.accountId = ['必填']
  // decimal.js isPositive() 含 0；对齐 shopspring IsPositive（仅 >0）
  if (debit.isNegative() || credit.isNegative() || (debit.gt(0) && credit.gt(0))) {
    fields.amount = ['借贷金额不得为负且至多一边大于零']
  }
  if ((partyType === null) !== (partyId === null)) {
    fields.partyId = ['对手类型与对手必须同时填写']
  }
  if (partyType !== null) {
    const normalized = partyType.trim().toLowerCase()
    if (!PARTY_KINDS.has(normalized)) {
      fields.partyType = ['只能为 SUPPLIER、CUSTOMER、COMPANY 或 EMPLOYEE']
    }
  }
  if (remarks != null && [...remarks].length > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('会计凭证行参数不合法', fields)
  }
  void idx
}

async function validateLineReferences(
  db: DbHandle,
  companyId: string,
  accountId: string,
  partyType: string | null,
  partyId: string | null,
): Promise<string | null> {
  const account = await db
    .selectFrom('bas_account')
    .select(['id', 'company_id', 'currency_id', 'is_group', 'active'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  if (!account) throw validation('accountId', '科目不存在')
  if (account.company_id !== companyId) {
    throw validation('accountId', '科目必须属于凭证所在公司')
  }
  if (account.is_group) throw validation('accountId', '汇总科目不能入账')
  if (!account.active) throw validation('accountId', '停用科目不能入账')

  if (partyType && partyId) {
    const kind = partyType.trim().toLowerCase()
    let exists = false
    if (kind === 'supplier') {
      exists = !!(await db
        .selectFrom('pur_supplier')
        .select('id')
        .where('id', '=', partyId)
        .executeTakeFirst())
    } else if (kind === 'customer') {
      exists = !!(await db
        .selectFrom('sal_customers')
        .select('id')
        .where('id', '=', partyId)
        .executeTakeFirst())
    } else if (kind === 'company') {
      exists = !!(await db
        .selectFrom('bas_company')
        .select('id')
        .where('id', '=', partyId)
        .executeTakeFirst())
    } else if (kind === 'employee') {
      exists = !!(await db
        .selectFrom('hr_employees')
        .select('id')
        .where('id', '=', partyId)
        .executeTakeFirst())
    }
    if (!exists) throw validation('partyId', '对手不存在')
  }
  return account.currency_id
}

async function validatePersistedLine(
  db: DbHandle,
  companyId: string,
  line: {
    idx: number
    accountId: string
    debit: ReturnType<typeof decimal>
    credit: ReturnType<typeof decimal>
    partyType: string | null
    partyId: string | null
    remarks: string | null
    currencyId: string | null
  },
): Promise<void> {
  validateLineShape(
    line.idx,
    line.accountId,
    line.debit,
    line.credit,
    line.partyType,
    line.partyId,
    line.remarks,
  )
  const currency = await validateLineReferences(
    db,
    companyId,
    line.accountId,
    line.partyType,
    line.partyId,
  )
  if ((currency === null) !== (line.currencyId === null) || currency !== line.currencyId) {
    throw validation('currencyId', '行币种与科目币种不一致')
  }
}

interface JournalLineFilter {
  accountId: string
  side: 'debit' | 'credit'
  amount: string
}

function splitJournalLineFilter(
  source: ListQuery['filter'] | undefined,
): {
  ordinaryFilter: ListQuery['filter'] | undefined
  lineFilter: JournalLineFilter | null
} {
  if (!source || !('lines' in source)) {
    return { ordinaryFilter: source, lineFilter: null }
  }
  const ordinaryFilter: NonNullable<ListQuery['filter']> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'lines') ordinaryFilter[key] = value
  }
  const raw = source.lines as unknown
  if (typeof raw !== 'object' || raw === null) {
    throw validation('lines', '行筛选格式错误')
  }
  const body = raw as {
    accountId?: { eq?: string }
    debit?: { greaterThan?: string }
    credit?: { greaterThan?: string }
  }
  if (!body.accountId?.eq) {
    throw validation('lines', '行筛选格式错误')
  }
  const accountId = body.accountId.eq
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    throw validation('lines.accountId', '必须是 UUID')
  }
  if ((body.debit == null) === (body.credit == null)) {
    throw validation('lines', '借方或贷方筛选必须且只能提供一个')
  }
  let side: 'debit' | 'credit' = 'debit'
  let rawAmount = ''
  if (body.debit) {
    rawAmount = body.debit.greaterThan ?? ''
  } else {
    side = 'credit'
    rawAmount = body.credit?.greaterThan ?? ''
  }
  if (!isDecimalString(rawAmount)) {
    throw validation(`lines.${side}`, 'greaterThan 必须是 decimal string')
  }
  return {
    ordinaryFilter: Object.keys(ordinaryFilter).length > 0 ? ordinaryFilter : undefined,
    lineFilter: { accountId, side, amount: rawAmount },
  }
}
