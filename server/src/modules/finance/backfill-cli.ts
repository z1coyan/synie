/**
 * 账务重放补过账 CLI 实现（W2/W3/W4/W5 唯一 TS 入口的库层）。
 * 入口脚本：scripts/jdy-replay/backfill_cli.ts
 */
import { readFileSync } from 'node:fs'
import type { Kysely } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { DB as Database } from '~/db/types.ts'
import { createGlEngine } from '~/engines/gl/index.ts'
import { systemPermit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import { buildNumberingCatalog, createNumberingService } from '~/platform/numbering/index.ts'
import { createReconciliationService } from '~/modules/trading/reconciliation/service.ts'
import { runDeliveryRemainBackfill } from '~/modules/trading/fulfillment/delivery-remain-backfill.ts'
import { createBillService } from './bill-service.ts'
import { createVatInvoiceService } from './invoice-service.ts'

export const BACKFILL_KINDS = ['invoice', 'bill', 'delivery-remain'] as const
export type BackfillKind = (typeof BACKFILL_KINDS)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BackfillCliArgs {
  kind: BackfillKind
  idsFile: string
  ids: string[]
  apply: boolean
}

export interface BackfillDocResult {
  id: string
  status: 'ok' | 'dry-run'
}

/** 发票/承兑逐 id 失败：已提交的 docs 保留，当前 id 写入 JSON，不并成一个大事务 */
export class BackfillItemError extends Error {
  readonly id: string
  readonly docs: BackfillDocResult[]

  constructor(id: string, cause: unknown, docs: BackfillDocResult[]) {
    const detail =
      cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause)
    super(detail)
    this.name = 'BackfillItemError'
    this.id = id
    this.docs = docs
    this.cause = cause
  }
}

export interface BackfillCliResult {
  kind: BackfillKind
  apply: boolean
  ids: number
  docs?: BackfillDocResult[]
  deliveryRemain?: Awaited<ReturnType<typeof runDeliveryRemainBackfill>>
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliArgs {
  let kind: string | undefined
  let idsFile: string | undefined
  let sawDryRun = false
  let sawApply = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--kind') {
      kind = needValue(argv, ++i, '--kind')
    } else if (arg === '--ids-file') {
      idsFile = needValue(argv, ++i, '--ids-file')
    } else if (arg === '--dry-run') {
      sawDryRun = true
    } else if (arg === '--apply') {
      sawApply = true
    } else {
      throw new Error(`不支持的参数：${arg}（只认 --kind / --ids-file / --dry-run / --apply）`)
    }
  }

  if (!kind) throw new Error('必须指定 --kind invoice|bill|delivery-remain')
  if (!(BACKFILL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--kind 必须是 invoice|bill|delivery-remain，收到：${kind}`)
  }
  if (!idsFile) throw new Error('必须指定 --ids-file')
  if (sawDryRun && sawApply) throw new Error('不能同时指定 --dry-run 与 --apply')

  return {
    kind: kind as BackfillKind,
    idsFile,
    ids: readIdsFile(idsFile),
    apply: sawApply,
  }
}

export async function runBackfill(
  db: Kysely<Database>,
  args: BackfillCliArgs,
): Promise<BackfillCliResult> {
  if (args.kind === 'delivery-remain') {
    const permit = systemPermit('salDeliveries', 'audit')
    const deliveryRemain = await runDeliveryRemainBackfill(db, permit, {
      ids: args.ids,
      apply: args.apply,
    })
    return { kind: args.kind, apply: args.apply, ids: args.ids.length, deliveryRemain }
  }

  const registry = createSealedResourceRegistry()
  const numbering = createNumberingService(db, buildNumberingCatalog(registry), registry)
  const gl = createGlEngine()

  if (args.kind === 'invoice') {
    const permit = systemPermit('accVatInvoices', 'audit')
    if (!args.apply) {
      return {
        kind: args.kind,
        apply: false,
        ids: args.ids.length,
        docs: args.ids.map((id) => ({ id, status: 'dry-run' })),
      }
    }
    const reconciliations = createReconciliationService(db, numbering, gl, registry)
    const invoices = createVatInvoiceService(db, numbering, { gl, reconciliations, registry })
    const docs = await backfillEachDoc(args.kind, args.ids, (id) => invoices.backfillPostedGL(permit, id))
    return { kind: args.kind, apply: true, ids: args.ids.length, docs }
  }

  const permit = systemPermit('accBillTransactions', 'audit')
  if (!args.apply) {
    return {
      kind: args.kind,
      apply: false,
      ids: args.ids.length,
      docs: args.ids.map((id) => ({ id, status: 'dry-run' })),
    }
  }
  const bills = createBillService(db, numbering, { gl, registry })
  const docs = await backfillEachDoc(args.kind, args.ids, (id) => bills.backfillPostedGL(permit, id))
  return { kind: args.kind, apply: true, ids: args.ids.length, docs }
}

export async function backfillEachDoc(
  kind: 'invoice' | 'bill',
  ids: string[],
  runOne: (id: string) => Promise<unknown>,
): Promise<BackfillDocResult[]> {
  const docs: BackfillDocResult[] = []
  for (const id of ids) {
    console.log(JSON.stringify({ level: 'info', msg: 'backfill_item', kind, id }))
    try {
      await runOne(id)
    } catch (err) {
      throw new BackfillItemError(id, err, docs)
    }
    docs.push({ id, status: 'ok' })
  }
  return docs
}

export function resolveBackfillDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (!env.PGDATABASE) {
    throw new Error('必须设置 DATABASE_URL 或 PGDATABASE')
  }
  const user = env.PGUSER ?? 'postgres'
  const auth = env.PGPASSWORD
    ? `${encodeURIComponent(user)}:${encodeURIComponent(env.PGPASSWORD)}`
    : encodeURIComponent(user)
  const host = env.PGHOST ?? 'localhost'
  const port = env.PGPORT ?? '5432'
  return `postgres://${auth}@${host}:${port}/${env.PGDATABASE}?sslmode=disable`
}

export async function main(argv: string[]): Promise<void> {
  let db: Kysely<Database> | undefined
  try {
    const args = parseBackfillCliArgs(argv)
    db = createDb(resolveBackfillDatabaseUrl())
    const result = await runBackfill(db, args)
    console.log(JSON.stringify({ level: 'info', msg: 'backfill_done', ...result }))
  } catch (err) {
    console.error(JSON.stringify(formatBackfillFailure(err)))
    process.exitCode = 1
  } finally {
    if (db) await db.destroy()
  }
}

export function formatBackfillFailure(err: unknown): Record<string, unknown> {
  if (err instanceof BackfillItemError) {
    return {
      level: 'error',
      msg: 'backfill_failed',
      id: err.id,
      error: err.message,
      docs: err.docs,
    }
  }
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
  return { level: 'error', msg: 'backfill_failed', error: message }
}

function needValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} 需要参数`)
  }
  return value
}

function readIdsFile(path: string): string[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`无法读取 --ids-file ${path}：${detail}`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!UUID_RE.test(line)) {
      throw new Error(`--ids-file 含非法 UUID：${line}`)
    }
    const id = line.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
