/**
 * 总账事实引擎：唯一写入/生命周期变更 acc_gl_entry 的应用路径。
 * 行为对齐 server-go/internal/engines/gl；事务边界归调用方（DbHandle）。
 */
import { decimal, toDecimalString, type Decimal } from '@synie/shared'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { GlEngine, GlEntry, GlVoucher, GlVoucherRef, PostOptions } from './types.ts'

/** 必须带对手的往来角色（与 Go partyAccountRoles 一致；比较时小写） */
const PARTY_ACCOUNT_ROLES = new Set([
  'unbilled_receivable',
  'receivable',
  'advance_received',
  'unbilled_payable',
  'payable',
  'advance_paid',
  'other_payable',
])

interface AccountRow {
  name: string
  companyId: string
  isGroup: boolean
  active: boolean
  role: string
}

interface NormalizedEntry {
  accountId: string
  currencyId: string | null
  debit: Decimal
  credit: Decimal
  partyType: string | null
  partyId: string | null
  remarks: string | null
  isReversal: boolean
}

export function createGlEngine(): GlEngine {
  return {
    post,
    cancel,
    reverse,
    validateEntries,
  }
}

/** 校验形状 + 科目 + 往来对手，不写库 */
export async function validateEntries(
  db: DbHandle,
  companyId: string,
  entries: GlEntry[],
  options: PostOptions = {},
): Promise<void> {
  if (!companyId) {
    throw ApiError.validation('总账过账参数不合法', { companyId: ['必填'] })
  }
  const normalized = normalizeAndValidateShape(entries, options.allowNegative === true)
  await loadAndValidateAccounts(db, companyId, normalized)
}

/**
 * 校验并追加分录。不 begin/commit/rollback；调用方持有 trx。
 */
export async function post(
  db: DbHandle,
  voucher: GlVoucher,
  entries: GlEntry[],
  options: PostOptions = {},
): Promise<void> {
  validateVoucher(voucher)
  const normalized = normalizeAndValidateShape(entries, options.allowNegative === true)
  await loadAndValidateAccounts(db, voucher.companyId, normalized)

  for (const entry of normalized) {
    try {
      await db
        .insertInto('acc_gl_entry')
        .values({
          company_id: voucher.companyId,
          account_id: entry.accountId,
          currency_id: entry.currencyId,
          posting_date: toDateOnly(voucher.postingDate),
          debit: toDecimalString(entry.debit),
          credit: toDecimalString(entry.credit),
          party_type: entry.partyType,
          party_id: entry.partyId,
          voucher_type: voucher.type,
          voucher_id: voucher.id,
          voucher_no: voucher.no,
          remarks: entry.remarks,
          is_reversal: entry.isReversal,
        })
        .execute()
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError('internal', '写入总账分录失败', { cause: err })
    }
  }
}

/**
 * 将来源单据下当前未作废分录全部标记 is_cancelled。重复调用幂等。
 */
export async function cancel(db: DbHandle, ref: GlVoucherRef): Promise<void> {
  validateRef(ref)
  try {
    await db
      .updateTable('acc_gl_entry')
      .set({ is_cancelled: true })
      .where('voucher_type', '=', ref.type)
      .where('voucher_id', '=', ref.id)
      .where('is_cancelled', '=', false)
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '作废总账分录失败', { cause: err })
  }
}

/**
 * 锁定原可红冲组 → 取负追加红字组 → 标记原组 is_reversed。
 * 无可红冲分录或并发重复红冲 → conflict。
 */
export async function reverse(
  db: DbHandle,
  ref: GlVoucherRef,
  postingDate: Date | string,
): Promise<void> {
  validateRef(ref)
  if (!postingDate || (postingDate instanceof Date && Number.isNaN(postingDate.getTime()))) {
    throw ApiError.validation('总账红冲参数不合法', { postingDate: ['必填'] })
  }
  if (typeof postingDate === 'string' && postingDate.trim() === '') {
    throw ApiError.validation('总账红冲参数不合法', { postingDate: ['必填'] })
  }

  let originals: Array<{
    id: string
    account_id: string
    currency_id: string | null
    debit: string
    credit: string
    party_type: string | null
    party_id: string | null
    remarks: string | null
    voucher_no: string
    company_id: string
  }>
  try {
    originals = await db
      .selectFrom('acc_gl_entry')
      .select([
        'id',
        'account_id',
        'currency_id',
        'debit',
        'credit',
        'party_type',
        'party_id',
        'remarks',
        'voucher_no',
        'company_id',
      ])
      .where('voucher_type', '=', ref.type)
      .where('voucher_id', '=', ref.id)
      .where('is_cancelled', '=', false)
      .where('is_reversed', '=', false)
      .where('is_reversal', '=', false)
      .orderBy('seq', 'asc')
      .forUpdate()
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '读取待红冲总账分录失败', { cause: err })
  }

  if (originals.length === 0) {
    throw new ApiError('conflict', '该单据没有可红冲的分录')
  }

  const first = originals[0]!
  const redEntries: GlEntry[] = originals.map((original) => {
    let remark = '红冲'
    if (original.remarks && original.remarks !== '') {
      remark += `:${original.remarks}`
    }
    return {
      accountId: original.account_id,
      currencyId: original.currency_id,
      debit: decimal(original.debit).neg(),
      credit: decimal(original.credit).neg(),
      partyType: original.party_type,
      partyId: original.party_id,
      remarks: remark,
      isReversal: true,
    }
  })
  const ids = originals.map((row) => row.id)

  await post(
    db,
    {
      type: ref.type,
      id: ref.id,
      no: first.voucher_no,
      companyId: first.company_id,
      postingDate,
    },
    redEntries,
    { allowNegative: true },
  )

  let updated: bigint | number | string
  try {
    const result = await db
      .updateTable('acc_gl_entry')
      .set({ is_reversed: true })
      .where('id', 'in', ids)
      .where('is_reversed', '=', false)
      .executeTakeFirst()
    updated = result.numUpdatedRows
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '标记原总账分录已红冲失败', { cause: err })
  }

  if (Number(updated) !== ids.length) {
    throw new ApiError('conflict', '总账分录已被并发红冲')
  }
}

// ─── 内部校验 ───────────────────────────────────────────────

function validateVoucher(voucher: GlVoucher): void {
  const fields: Record<string, string[]> = {}
  const type = voucher.type?.trim() ?? ''
  if (type === '' || type.length > 64) {
    fields.voucherType = ['必填且最多 64 个字符']
  }
  if (!voucher.id) {
    fields.voucherId = ['必填']
  }
  const no = voucher.no?.trim() ?? ''
  if (no === '' || no.length > 64) {
    fields.voucherNo = ['必填且最多 64 个字符']
  }
  if (!voucher.companyId) {
    fields.companyId = ['必填']
  }
  if (
    !voucher.postingDate ||
    (voucher.postingDate instanceof Date && Number.isNaN(voucher.postingDate.getTime())) ||
    (typeof voucher.postingDate === 'string' && voucher.postingDate.trim() === '')
  ) {
    fields.postingDate = ['必填']
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('总账过账参数不合法', fields)
  }
}

function validateRef(ref: GlVoucherRef): void {
  if (!ref.type?.trim() || !ref.id) {
    throw ApiError.validation('总账来源单据参数不合法', {
      voucher: ['来源单据类型和 ID 必填'],
    })
  }
}

function normalizeAndValidateShape(entries: GlEntry[], allowNegative: boolean): NormalizedEntry[] {
  if (entries.length < 2) {
    throw ledgerValidation('分录不少于两行')
  }

  let debitTotal = decimal(0)
  let creditTotal = decimal(0)
  const normalized: NormalizedEntry[] = []

  for (const entry of entries) {
    if (!entry.accountId) {
      throw ledgerValidation('科目不存在')
    }
    const debit = decimal(entry.debit ?? 0)
    const credit = decimal(entry.credit ?? 0)
    const debitNonzero = !debit.isZero()
    const creditNonzero = !credit.isZero()
    if (debitNonzero === creditNonzero || (!allowNegative && (debit.isNegative() || credit.isNegative()))) {
      if (allowNegative) {
        throw ledgerValidation('每行借贷必须恰一边非零')
      }
      throw ledgerValidation('每行借贷必须恰一边大于零')
    }

    const partyType = entry.partyType ?? null
    const partyId = entry.partyId ?? null
    if ((partyType === null) !== (partyId === null)) {
      throw ledgerValidation('对手类型与对手必须同时填写')
    }

    debitTotal = debitTotal.plus(debit)
    creditTotal = creditTotal.plus(credit)
    normalized.push({
      accountId: entry.accountId,
      currencyId: entry.currencyId ?? null,
      debit,
      credit,
      partyType,
      partyId,
      remarks: entry.remarks ?? null,
      isReversal: entry.isReversal === true,
    })
  }

  if (!debitTotal.eq(creditTotal)) {
    throw ledgerValidation('借贷不平')
  }
  return normalized
}

async function loadAndValidateAccounts(
  db: DbHandle,
  companyId: string,
  entries: NormalizedEntry[],
): Promise<Map<string, AccountRow>> {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.accountId)) continue
    seen.add(entry.accountId)
    ids.push(entry.accountId)
  }

  let rows: Array<{
    id: string
    name: string
    company_id: string
    is_group: boolean
    active: boolean
    role: string | null
  }>
  try {
    rows = await db
      .selectFrom('bas_account')
      .select(['id', 'name', 'company_id', 'is_group', 'active', 'role'])
      .where('id', 'in', ids)
      .execute()
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError('internal', '读取过账科目失败', { cause: err })
  }

  const accounts = new Map<string, AccountRow>()
  for (const row of rows) {
    accounts.set(row.id, {
      name: row.name,
      companyId: row.company_id,
      isGroup: row.is_group,
      active: row.active,
      role: row.role ?? '',
    })
  }

  for (const id of ids) {
    const item = accounts.get(id)
    if (!item) {
      throw ledgerValidation('科目不存在')
    }
    if (item.companyId !== companyId) {
      throw ledgerValidation('科目必须属于单据公司')
    }
    if (item.isGroup) {
      throw ledgerValidation('汇总科目不能入账')
    }
    if (!item.active) {
      throw ledgerValidation('停用科目不能入账')
    }
  }

  for (const entry of entries) {
    const item = accounts.get(entry.accountId)!
    const role = item.role.toLowerCase()
    if (PARTY_ACCOUNT_ROLES.has(role) && entry.partyId === null && !entry.isReversal) {
      throw ledgerValidation(`往来科目「${item.name}」的分录必须填写对手`)
    }
  }

  return accounts
}

function ledgerValidation(message: string): ApiError {
  return ApiError.validation('总账过账校验失败', { entries: [message] })
}

/** 业务日 → YYYY-MM-DD（UTC 组件，对齐 Go pgtype.Date / UTC fixture） */
export function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.trim().slice(0, 10)
  }
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 仅导出形状校验供单测（不经 DB） */
export function validateShapeForTest(entries: GlEntry[], allowNegative = false): void {
  normalizeAndValidateShape(entries, allowNegative)
}
