import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createDb } from './index.ts'
import { withReadSnapshot } from './tx.ts'

const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（读快照事务）', () => {
  const db = createDb(url!)

  afterAll(async () => {
    await db.destroy()
  })

  test('withReadSnapshot 使用 repeatable read 隔离级别', async () => {
    const isolation = await withReadSnapshot(db, async (snapshot) => {
      const result = await sql<{ transaction_isolation: string }>`
        SHOW transaction_isolation
      `.execute(snapshot)
      return result.rows[0]?.transaction_isolation
    })

    expect(isolation).toBe('repeatable read')
  })
})
