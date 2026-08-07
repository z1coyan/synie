/**
 * 手工会计凭证（头 + 行）。
 *
 * 单头走标准动作内核：CRUD（create 经 hooks.insertColumns 盖 created_by_id、
 * 经 numbering 自动取号）+ workflow 两转移（audit/cancel），effect 只调 GL 引擎，
 * 状态翻转/盖章/审计交内核。行走子行内核：母单草稿门 + company_id 带入 +
 * currency_id 科目派生列。禁止直写 acc_gl_entry。
 *
 * 一处按动作弹射：
 * - `createAndAuditJournal`：调用方 trx 内的无闸 seam（内核动作自开事务且只收
 *   Permit），故保留手写在途实现，与内核路径共用校验/取分录/审计快照helpers。
 *
 * `list` 的 `lines` 行内 EXISTS 筛选走内核 `extraWhere`（T1.5）：剥离 filter 伪字段
 * 后交给 filterbuild，EXISTS 谓词 AND 授权。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`（工作流 audit/cancel 逐动作挂码），
 * 本服务只收 Permit。凭证行是 via(凭证头)，判定递归母单。
 */
import { decimal, isDecimalString, type Decimal, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import type { GlEngine, GlEntry } from '~/engines/gl/index.ts'
import { auditCreated, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Actor, Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { runeLen } from '~/platform/posting/text.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardChildService } from '~/platform/standard/child.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { mapWriteError } from '~/db/dberr.ts'
import {
  JOURNAL_LINE_RESOURCE_NAME,
  JOURNAL_RESOURCE_NAME,
  journalLineResourceMeta,
  journalResourceMeta,
} from './meta.ts'

export { JOURNAL_LINE_RESOURCE_NAME, JOURNAL_RESOURCE_NAME } from './meta.ts'

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
  [key: string]: unknown
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
  [key: string]: unknown
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

/** PATCH 补丁（present-key 语义：键出现即写，null 清空，缺省不动） */
export interface UpdateJournalInput {
  voucherNo?: string
  date?: string
  postingDate?: string | null
  remarks?: string | null
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

/** 行 PATCH 补丁（present-key 语义，同单头） */
export interface UpdateLineInput {
  idx?: number
  accountId?: string
  debit?: string
  credit?: string
  partyType?: string | null
  partyId?: string | null
  remarks?: string | null
}

const JOURNAL_META = journalResourceMeta()
const LINE_META = journalLineResourceMeta()

const JOURNAL_AUDIT = auditFieldsOf(JOURNAL_META)
const LINE_AUDIT = auditFieldsOf(LINE_META)

const PARTY_KINDS = new Set(['supplier', 'customer', 'company', 'employee'])
const VOUCHER_TYPE = 'acc.gl_journal'
/** 列表/单条共用的投影别名（FROM (…) AS journals / journal_lines） */
const JOURNAL_ALIAS = 'journals'
const LINE_ALIAS = 'journal_lines'

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

/** 投影附加列（物理列由内核自 meta 派生，此处只列 join/聚合出来的） */
const JOURNAL_EXTRA_COLS = sql`debit_total, credit_total, company_name, created_by_name, submitted_by_name`

const JOURNAL_SELECT = sql`SELECT id, voucher_no, date, posting_date, remarks, status,
submitted_at, inserted_at, updated_at, company_id, created_by_id, submitted_by_id,
debit_total, credit_total, company_name, created_by_name, submitted_by_name`

const JOURNAL_ORDER = sql`"date" DESC, "voucher_no" ASC, "id" ASC`

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

const LINE_EXTRA_COLS = sql`voucher_no, company_name, account_code, account_name, currency_code, currency_name`

const WRITE_MAPPINGS = [
  { code: '23505', message: '同一公司内凭证编号必须唯一' },
  { code: '23503', message: '会计凭证参数不合法' },
] as const

export type JournalService = ReturnType<typeof createJournalService>

export interface JournalServiceDeps {
  /**
   * 银行对账只读接缝：凭证是否已被 acc_bank_reconciliation 引用。
   * 由组合根注入 banking-recon 的 isJournalLinkedToBankRecon；
   * 缺省则取消时不做该检查（仅限单测）。
   */
  isJournalLinkedToBankRecon?: (db: DbHandle, journalId: string) => Promise<boolean>
}

export function createJournalService(
  db: Kysely<Database>,
  numbering: NumberingService,
  gl: GlEngine,
  registry: Registry,
  deps: JournalServiceDeps = {},
) {
  const isJournalLinkedToBankRecon = deps.isJournalLinkedToBankRecon

  /** 审核用：复核持久化行并折成 GL 分录（内核 effect 与内部 seam 共用） */
  async function collectEntries(
    trx: TrxHandle,
    companyId: string,
    journalId: string,
  ): Promise<GlEntry[]> {
    const lineRows = await trx
      .selectFrom('acc_gl_journal_line')
      .selectAll()
      .where('journal_id', '=', journalId)
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
      await validatePersistedLine(trx, companyId, line)
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
    return entries
  }

  const base: StandardService<Journal> = createStandardService<Journal>({
    db,
    registry,
    resource: JOURNAL_RESOURCE_NAME,
    notFound: '会计凭证不存在',
    defaultOrder: JOURNAL_ORDER,
    writeErrors: [...WRITE_MAPPINGS],
    projection: {
      source: JOURNAL_SOURCE,
      alias: JOURNAL_ALIAS,
      selectExtra: JOURNAL_EXTRA_COLS,
      mapExtra: journalExtras,
    },
    numbering: { service: numbering, field: 'voucherNo' },
    // lines 伪筛选 → EXISTS；剥离后的 ordinaryFilter 交给 filterbuild（T1.5）
    extraWhere: ({ query, alias }) => {
      const { ordinaryFilter, lineFilter } = splitJournalLineFilter(query.filter as ListQuery['filter'])
      return {
        query: { ...query, filter: ordinaryFilter },
        where: lineFilter
          ? sql`EXISTS (
            SELECT 1 FROM acc_gl_journal_line lf
            WHERE lf.journal_id = ${sql.raw(alias)}.id
              AND lf.account_id = ${lineFilter.accountId}::uuid
              AND lf.${sql.raw(lineFilter.side)} > ${lineFilter.amount}
          )`
          : null,
      }
    },
    hooks: {
      validate: ({ action, draft }) => validateJournalDraft(action, draft),
      // 服务端派生插入列：本资源无 owner 绑定，created_by_id 是 readonly 系统列
      insertColumns: ({ permit }) => ({ created_by_id: actorUserId(permit.actor) }),
    },
    workflow: {
      mutableMessage: '仅草稿凭证可修改或删除',
      transitions: [
        {
          key: 'audit',
          label: '审核',
          from: ['DRAFT'],
          to: 'AUDITED',
          guardMessage: '仅草稿凭证可审核',
          effect: async (trx, { permit, before, input }) => {
            const effectiveDate = resolvePostingDate(
              input.postingDate as string | null | undefined,
              before.postingDate as string | null,
            )
            const entries = await collectEntries(trx, String(before.companyId), String(before.id))
            await gl.post(
              trx,
              {
                type: VOUCHER_TYPE,
                id: String(before.id),
                no: String(before.voucherNo),
                companyId: String(before.companyId),
                postingDate: effectiveDate,
              },
              entries,
            )
            return {
              posting_date: effectiveDate,
              submitted_at: sql`(now() AT TIME ZONE 'utc')`,
              submitted_by_id: actorUserId(permit.actor),
            }
          },
        },
        {
          key: 'cancel',
          label: '取消',
          from: ['AUDITED'],
          to: 'CANCELLED',
          guardMessage: '仅已审核凭证可取消',
          effect: async (trx, { before }) => {
            if (isJournalLinkedToBankRecon) {
              const used = await isJournalLinkedToBankRecon(trx, String(before.id))
              if (used) {
                throw new ApiError('conflict', '凭证已用于银行对账,请先解除对账')
              }
            }
            await gl.cancel(trx, { type: VOUCHER_TYPE, id: String(before.id) })
          },
        },
      ],
    },
  })

  const lines = createStandardChildService<JournalLine>({
    db,
    registry,
    resource: JOURNAL_LINE_RESOURCE_NAME,
    notFound: '会计凭证行不存在',
    defaultOrder: sql`"idx" ASC, "id" ASC`,
    writeErrors: [...WRITE_MAPPINGS],
    parent: {
      resource: JOURNAL_RESOURCE_NAME,
      fkField: 'journalId',
      notFound: '会计凭证不存在',
      inheritFields: ['companyId'],
      gate: (journal) => {
        if (journal.status !== 'DRAFT') {
          throw new ApiError('conflict', '仅草稿凭证可编辑分录行')
        }
      },
    },
    // 科目币种：readonly 派生列，随 INSERT/UPDATE 落库
    derivedFields: ['currencyId'],
    projection: {
      source: LINE_SOURCE,
      alias: LINE_ALIAS,
      selectExtra: LINE_EXTRA_COLS,
      mapExtra: lineExtras,
    },
    // 行无名称列（名称在 join 出来的引用上）：审计标签取行号
    recordLabel: (item) => String(item.idx),
    hooks: {
      validate: ({ draft }) => {
        validateLineShape(
          Number(draft.idx),
          String(draft.accountId ?? ''),
          decimal(String(draft.debit ?? '0')),
          decimal(String(draft.credit ?? '0')),
          (draft.partyType as string | null) ?? null,
          (draft.partyId as string | null) ?? null,
          (draft.remarks as string | null) ?? null,
        )
      },
      beforeWrite: async (trx, { draft, parent }) => {
        draft.currencyId = await validateLineReferences(
          trx,
          String(parent.companyId),
          String(draft.accountId),
          (draft.partyType as string | null) ?? null,
          (draft.partyId as string | null) ?? null,
        )
      },
    },
  })

  // ─── 内部 seam（弹射）：调用方 trx 内建凭证并审核过账 ───────────

  /** 建头（校验→取号→插入→审计）；返回裸行 wire 形 */
  async function insertJournalInTx(
    trx: TrxHandle,
    actor: Actor,
    input: CreateJournalInput,
  ): Promise<Journal> {
    const draft: Record<string, unknown> = {
      voucherNo: input.voucherNo ?? '',
      date: input.date,
      remarks: input.remarks ?? null,
    }
    if (!input.companyId) {
      throw validation('companyId', '必填')
    }
    validateJournalDraft('create', draft)
    // 凭证号一律系统生成（ADR 2026-08-06-system-generated-numbering）：内部 seam 同样不接受传号
    const voucherNo = await numbering.assignedInTx(trx, {
      resource: VOUCHER_TYPE,
      field: 'voucherNo',
      provided: String(draft.voucherNo ?? ''),
      values: { company_id: input.companyId, date: input.date },
    })
    if (runeLen(voucherNo) > 32) {
      throw validation('voucherNo', '最多 32 个字符')
    }
    try {
      const row = await trx
        .insertInto('acc_gl_journal')
        .values({
          voucher_no: voucherNo,
          date: input.date,
          posting_date: input.postingDate ?? null,
          remarks: input.remarks ?? null,
          company_id: input.companyId,
          created_by_id: actorUserId(actor),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      const item = mapRow(JOURNAL_META, row as unknown as Record<string, unknown>) as Journal
      await writeAudit(trx, actor, {
        resource: JOURNAL_META.table,
        recordId: item.id,
        recordLabel: item.voucherNo,
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(snapshot(JOURNAL_META, item, JOURNAL_AUDIT), JOURNAL_AUDIT),
      })
      return item
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建会计凭证失败', WRITE_MAPPINGS)
    }
  }

  /** 建行（形状/引用校验→插入→审计） */
  async function insertLineInTx(
    trx: TrxHandle,
    actor: Actor,
    journal: { id: string; companyId: string },
    input: CreateLineInput,
  ): Promise<void> {
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
      journal.companyId,
      input.accountId,
      input.partyType ?? null,
      input.partyId ?? null,
    )
    try {
      const row = await trx
        .insertInto('acc_gl_journal_line')
        .values({
          idx: input.idx,
          debit: debit.toFixed(),
          credit: credit.toFixed(),
          party_type: normalizePartyDb(input.partyType ?? null),
          party_id: input.partyId ?? null,
          remarks: input.remarks ?? null,
          journal_id: journal.id,
          company_id: journal.companyId,
          account_id: input.accountId,
          currency_id: currencyId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      const item = mapRow(LINE_META, row as unknown as Record<string, unknown>) as JournalLine
      await writeAudit(trx, actor, {
        resource: LINE_META.table,
        recordId: item.id,
        recordLabel: String(item.idx),
        companyId: item.companyId,
        actionType: 'create',
        actionName: 'create',
        changes: auditCreated(snapshot(LINE_META, item, LINE_AUDIT), LINE_AUDIT),
      })
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw mapWriteError(err, '创建会计凭证行失败', WRITE_MAPPINGS)
    }
  }

  /** 审核过账（裸锁→复核行→GL→状态翻转→审计）；调用方已鉴权 */
  async function auditJournalInTx(
    trx: TrxHandle,
    actor: Actor,
    id: string,
    postingDate: string | null | undefined,
  ): Promise<Journal> {
    const locked = await trx
      .selectFrom('acc_gl_journal')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!locked) throw new ApiError('not_found', '会计凭证不存在')
    const before = mapRow(JOURNAL_META, locked as unknown as Record<string, unknown>) as Journal
    if (before.status !== 'DRAFT') {
      throw new ApiError('conflict', '仅草稿凭证可审核')
    }
    const effectiveDate = resolvePostingDate(postingDate, before.postingDate)
    const entries = await collectEntries(trx, before.companyId, id)
    await gl.post(
      trx,
      {
        type: VOUCHER_TYPE,
        id,
        no: before.voucherNo,
        companyId: before.companyId,
        postingDate: effectiveDate,
      },
      entries,
    )
    const updated = await trx
      .updateTable('acc_gl_journal')
      .set({
        status: 'audited',
        posting_date: effectiveDate,
        submitted_at: sql`(now() AT TIME ZONE 'utc')`,
        submitted_by_id: actorUserId(actor),
        updated_at: sql`(now() AT TIME ZONE 'utc')`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    const after = mapRow(JOURNAL_META, updated as unknown as Record<string, unknown>) as Journal
    await writeAudit(trx, actor, {
      resource: JOURNAL_META.table,
      recordId: after.id,
      recordLabel: after.voucherNo,
      companyId: after.companyId,
      actionType: 'update',
      actionName: 'audit',
      changes: auditDiff(
        snapshot(JOURNAL_META, before, JOURNAL_AUDIT),
        snapshot(JOURNAL_META, after, JOURNAL_AUDIT),
        JOURNAL_AUDIT,
      ),
    })
    return loadJournal(trx, id)
  }

  /**
   * 内部 seam：调用方 trx 内一气呵成立凭证并审核过账。
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
    const journal = await insertJournalInTx(trx, actor, {
      companyId: input.companyId,
      date: input.date,
      postingDate: input.postingDate,
      remarks: input.remarks ?? null,
    })
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!
      await insertLineInTx(trx, actor, { id: journal.id, companyId: journal.companyId }, {
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
    ...base,
    audit: (permit: Permit, id: string, postingDate?: string | null) =>
      base.transition(permit, id, 'audit', { postingDate: postingDate ?? null }),
    cancel: (permit: Permit, id: string) => base.transition(permit, id, 'cancel'),
    createAndAuditJournal,
    getLine: lines.get,
    listLines: lines.list,
    createLine: lines.create,
    updateLine: lines.update,
    removeLine: lines.remove,
  }
}

// ─── helpers ───────────────────────────────────────────────

/** 仅真实 UUID 写入 created_by/submitted_by；空串/非法值 → null（对齐 Go uuid.Nil） */
function actorUserId(actor: Actor): string | null {
  const id = actor.userId?.trim() ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null
}

function validation(field: string, message: string): ApiError {
  return ApiError.validation('会计凭证参数不合法', { [field]: [message] })
}

/** 过账日期：入参优先，缺省取头上现值；两者皆空即 422（审核前必须有过账日期） */
function resolvePostingDate(
  input: string | null | undefined,
  current: string | null,
): string {
  const effective =
    input && input.trim() !== '' ? input.trim().slice(0, 10) : (current ?? null)
  if (!effective) {
    throw validation('postingDate', '审核过账前必须填写过账日期')
  }
  return effective
}

/**
 * 单头 wire 规范化 + 领域校验（内核钩子与内部 seam 共用）。
 * create：单号可空（取号补），长度上限；update：单号/日期必填。
 */
function validateJournalDraft(action: 'create' | 'update', draft: Record<string, unknown>): void {
  if (typeof draft.voucherNo === 'string') draft.voucherNo = draft.voucherNo.trim()
  const fields: Record<string, string[]> = {}
  const voucherNo = typeof draft.voucherNo === 'string' ? draft.voucherNo : null
  if (action === 'update') {
    if (voucherNo === null || voucherNo === '') fields.voucherNo = ['必填']
    else if (runeLen(voucherNo) > 32) fields.voucherNo = ['最多 32 个字符']
  } else if (voucherNo !== null && runeLen(voucherNo) > 32) {
    fields.voucherNo = ['最多 32 个字符']
  }
  const date = typeof draft.date === 'string' ? draft.date.trim() : ''
  if (date === '') fields.date = ['必填']
  const remarks = draft.remarks
  if (typeof remarks === 'string' && runeLen(remarks) > 512) {
    fields.remarks = ['最多 512 个字符']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('会计凭证参数不合法', fields)
  }
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

/** 单头投影附加键（join 出来的公司/编写人/提交人与借贷合计） */
function journalExtras(r: Record<string, unknown>): Record<string, unknown> {
  const companyId = String(r.company_id)
  const createdById = r.created_by_id == null ? null : String(r.created_by_id)
  const submittedById = r.submitted_by_id == null ? null : String(r.submitted_by_id)
  return {
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

/** 行投影附加键（凭证/公司/科目/币种引用） */
function lineExtras(r: Record<string, unknown>): Record<string, unknown> {
  const currencyId = r.currency_id == null ? null : String(r.currency_id)
  return {
    journal: { id: String(r.journal_id), voucherNo: String(r.voucher_no) },
    company: { id: String(r.company_id), name: String(r.company_name) },
    account: {
      id: String(r.account_id),
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

function mapJournalRow(r: Record<string, unknown>): Journal {
  return { ...mapRow(JOURNAL_META, r), ...journalExtras(r) } as Journal
}

/** 无授权的投影单条（内部 seam 的返回值；HTTP 路径一律经内核授权读） */
async function loadJournal(db: DbHandle, id: string): Promise<Journal> {
  const result = await sql<Record<string, unknown>>`
    ${JOURNAL_SELECT}
    ${JOURNAL_SOURCE}
    WHERE id = ${id}
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new ApiError('not_found', '会计凭证不存在')
  return mapJournalRow(row)
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
  if (remarks != null && runeLen(remarks) > 512) {
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
