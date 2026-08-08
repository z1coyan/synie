import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import {
  createFileReconcileService,
  summarizeFileReconcile,
} from '~/platform/files/reconcile.ts'

/**
 * 文件存储对账 PG 集成：真实 sys_storage/sys_file 行 + 本地存储目录。
 * 门控 SYNIE_TEST_DATABASE_URL（未设置则整组 Skip）。
 */
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（文件存储对账）', () => {
  const db = createDb(url!)
  const reconcile = createFileReconcileService({ db })

  afterAll(async () => {
    await db.destroy()
  })

  /** 造一个 local 接入点 + 目录；返回 { name, root } */
  async function fixture() {
    const name = `recon-${crypto.randomUUID().slice(0, 8)}`
    const root = join('/tmp', `synie-recon-${crypto.randomUUID()}`)
    mkdirSync(join(root, '2026/08'), { recursive: true })
    await db
      .insertInto('sys_storage')
      .values({ name, label: name, kind: 'local', root, builtin: false, is_default: false })
      .execute()
    return { name, root }
  }

  async function cleanup(name: string, root: string) {
    await db.deleteFrom('sys_file').where('storage', '=', name).execute()
    await db.deleteFrom('sys_storage').where('name', '=', name).execute()
    rmSync(root, { recursive: true, force: true })
  }

  function putObject(root: string, key: string, mtime?: Date) {
    const path = join(root, ...key.split('/'))
    writeFileSync(path, 'x')
    if (mtime) utimesSync(path, mtime, mtime)
  }

  async function insertFileRow(storage: string, key: string) {
    await db.insertInto('sys_file').values({ storage, key, filename: key }).execute()
  }

  test('dry-run：孤儿只报告不删除；宽限期内新对象不碰；缺失对象告警', async () => {
    const { name, root } = await fixture()
    const now = new Date('2026-08-08T04:00:00Z')
    try {
      // DB 有行 + 对象存在：正常
      putObject(root, '2026/08/ok.bin')
      await insertFileRow(name, '2026/08/ok.bin')
      // 孤儿（两天前）：应被报告
      putObject(root, '2026/08/orphan.bin', new Date('2026-08-06T04:00:00Z'))
      // 宽限期内的新对象（疑似进行中上传）：不碰
      putObject(root, '2026/08/fresh.bin', new Date('2026-08-08T03:30:00Z'))
      // DB 有行但对象缺失：告警
      await insertFileRow(name, '2026/08/missing.bin')

      const report = await reconcile.reconcile({
        dryRun: true,
        orphanGraceMs: 24 * 3600_000,
        now,
      })
      const s = report.storages.find((x) => x.storage === name)!
      expect(s.error).toBeNull()
      expect(s.orphans).toEqual(['2026/08/orphan.bin'])
      expect(s.freshOrphans).toBe(1)
      expect(s.deleted).toBe(0)
      expect(s.missing).toEqual(['2026/08/missing.bin'])
      // dry-run 不删
      expect(existsSync(join(root, '2026/08/orphan.bin'))).toBe(true)

      const summary = summarizeFileReconcile(report)
      expect(summary).toContain('演练')
      expect(summary).toContain('孤儿 1 个')
      expect(summary).toContain('对象缺失告警 1 个')
    } finally {
      await cleanup(name, root)
    }
  })

  test('执行模式：删除超宽限孤儿，删除后文件消失', async () => {
    const { name, root } = await fixture()
    const now = new Date('2026-08-08T04:00:00Z')
    try {
      putObject(root, '2026/08/orphan.bin', new Date('2026-08-06T04:00:00Z'))
      putObject(root, '2026/08/ok.bin')
      await insertFileRow(name, '2026/08/ok.bin')

      const report = await reconcile.reconcile({
        dryRun: false,
        orphanGraceMs: 24 * 3600_000,
        now,
      })
      const s = report.storages.find((x) => x.storage === name)!
      expect(s.orphans).toEqual(['2026/08/orphan.bin'])
      expect(s.deleted).toBe(1)
      expect(s.deleteFailed).toBe(0)
      expect(existsSync(join(root, '2026/08/orphan.bin'))).toBe(false)
      expect(existsSync(join(root, '2026/08/ok.bin'))).toBe(true)

      const summary = summarizeFileReconcile(report)
      expect(summary).toContain('执行')
    } finally {
      await cleanup(name, root)
    }
  })

  test('接入点配置不完整：记入 error 不影响其他接入点', async () => {
    const broken = `recon-broken-${crypto.randomUUID().slice(0, 8)}`
    await db
      .insertInto('sys_storage')
      .values({ name: broken, label: broken, kind: 's3', builtin: false, is_default: false })
      .execute()
    try {
      const report = await reconcile.reconcile({
        dryRun: true,
        orphanGraceMs: 24 * 3600_000,
        now: new Date(),
      })
      const s = report.storages.find((x) => x.storage === broken)!
      expect(s.error).toBeTruthy()
      const summary = summarizeFileReconcile(report)
      expect(summary).toContain('扫描失败接入点')
    } finally {
      await sql`DELETE FROM sys_storage WHERE name = ${broken}`.execute(db)
    }
  })
})
