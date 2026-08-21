import { describe, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import type { DB as Database } from '../../server/src/db/types.ts'
import { systemPermit } from '../../server/src/platform/authz/core/index.ts'
import { ApiError } from '../../server/src/platform/http/errors.ts'
import { runDeliveryRemainBackfill } from './delivery-remain-backfill.ts'

const db = {} as Kysely<Database>

describe('runDeliveryRemainBackfill 入参闸', () => {
  test('permit 必须是 salDeliveries/audit', async () => {
    const err = await runDeliveryRemainBackfill(db, systemPermit('accVatInvoices', 'audit'), {
      ids: [],
      apply: false,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('forbidden')
  })

  test('空 ids + apply 拒绝（不进事务、不删 0008）', async () => {
    const err = await runDeliveryRemainBackfill(db, systemPermit('salDeliveries', 'audit'), {
      ids: [],
      apply: true,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('conflict')
    expect((err as ApiError).message).toMatch(/不会删除 0008/)
  })
})
