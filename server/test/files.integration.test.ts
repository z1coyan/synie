import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'kysely'
import { createDb } from '~/db/index.ts'
import type { DB as Database } from '~/db/types.ts'
import type { Kysely } from 'kysely'
import { createRateLimiter } from '~/platform/auth/limiter.ts'
import { createAuthService } from '~/platform/auth/service.ts'
import { createAuthStore } from '~/platform/auth/store.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { onError, notFound } from '~/platform/http/errors.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { createRegistry } from '~/platform/meta/registry.ts'
import {
  createFileService,
  createOwnerRegistry,
  createStorageService,
  fileRoutes,
  registerFileResources,
  storageRoutes,
} from '~/platform/files/index.ts'
import { ensureAdmin } from '../db/seed-admin.ts'

/**
 * files / storages PG 集成 + 路由测试。
 * 门控 SYNIE_TEST_DATABASE_URL（未设置则整组 Skip）。
 */
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（files / storages）', () => {
  const db = createDb(url!)
  const owners = createOwnerRegistry()
  owners.register('sal_customer', {
    table: 'sal_customers',
    permissionPrefix: 'sales.customer',
  })
  owners.register('acc_gl_journal', {
    table: 'acc_gl_journal',
    permissionPrefix: 'acc.gl_journal',
    companyScoped: true,
  })

  const files = createFileService({ db, owners })
  const storages = createStorageService({ db })
  const registry = createRegistry()
  registerFileResources(registry)

  const authPromise = createAuthService({
    store: createAuthStore(db),
    tokens: createTokenManager({ secret: 'files-integration-secret-32bytes!!', ttlSeconds: 3600 }),
    limiter: createRateLimiter(),
  })

  const adminPassword = 'files-it-admin-pass'
  const adminUsername = `files-it-admin-${crypto.randomUUID().slice(0, 8)}`

  async function buildTestApp() {
    const auth = await authPromise
    await ensureAdmin(db, { username: adminUsername, password: adminPassword, name: '文件集成管理员' })
    const app = new Hono<AppEnv>()
      .basePath('/api/v1')
      .route('/files', fileRoutes({ auth, files }))
      .route('/system/storages', storageRoutes({ auth, storages }))
    app.onError(onError)
    app.notFound(notFound)
    return app
  }

  async function loginToken(): Promise<string> {
    // 测试 app 只挂 files/storages 路由；令牌直接由 AuthService 签发
    const auth = await authPromise
    const login = await auth.login({ username: adminUsername, password: adminPassword, bucket: 'test' })
    return login.token
  }

  afterAll(async () => {
    await db.destroy()
  })

  test('本地存储：上传/下载/挂接冲突删/元数据/列表路由', async () => {
    const fixture = await createFixture(db)
    try {
      const actor: Actor = {
        userId: fixture.userId,
        username: 'files-test',
        name: '文件测试',
        superAdmin: false,
        allCompanies: false,
        permissions: new Set([
          'sys.file:create',
          'sys.file:read',
          'sys.file:delete',
          'sales.customer:read',
        ]),
        companyIds: [],
      }

      const payload = new TextEncoder().encode('PDF 内容')
      const uploaded = await files.upload(actor, {
        data: payload,
        filename: '合同.PDF',
        contentType: 'application/pdf',
      })
      fixture.fileIds.push(uploaded.file.id)
      expect(uploaded.attachment).toBeUndefined()
      expect(uploaded.file.storage).toBe(fixture.storageName)
      expect(uploaded.file.size).toBe(payload.byteLength)
      expect(uploaded.file.key.endsWith('.pdf')).toBe(true)
      expect(uploaded.file.sha256.length).toBe(64)

      const other: Actor = {
        userId: crypto.randomUUID(),
        username: 'other',
        name: null,
        superAdmin: false,
        allCompanies: false,
        permissions: new Set(['sys.file:read']),
        companyIds: [],
      }
      await expect(files.download(other, uploaded.file.id)).rejects.toMatchObject({ code: 'forbidden' })

      const dl = await files.download(actor, uploaded.file.id)
      expect(new TextDecoder().decode(dl.content)).toBe('PDF 内容')

      const attachment = await files.attach(actor, uploaded.file.id, {
        ownerType: 'sal_customer',
        ownerId: fixture.customerId,
        category: 'contract',
      })
      fixture.attachmentIds.push(attachment.id)
      expect(attachment.category).toBe('contract')
      expect(attachment.companyId).toBeNull()

      await expect(files.deleteFile(actor, uploaded.file.id)).rejects.toMatchObject({ code: 'conflict' })

      await files.deleteAttachment(actor, attachment.id)
      fixture.attachmentIds = []
      await files.deleteFile(actor, uploaded.file.id)
      fixture.fileIds = []

      // 对象已清理
      const objectPath = join(fixture.root, ...uploaded.file.key.split('/'))
      expect(statSync(objectPath, { throwIfNoEntry: false })).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  test('未知宿主上传：回滚元数据且不留物理对象', async () => {
    const fixture = await createFixture(db)
    try {
      const actor: Actor = {
        userId: fixture.userId,
        username: 'files-test',
        name: null,
        superAdmin: false,
        allCompanies: false,
        permissions: new Set(['sys.file:create']),
        companyIds: [],
      }
      await expect(
        files.upload(actor, {
          data: new TextEncoder().encode('x'),
          filename: 'x.txt',
          contentType: 'text/plain',
          ownerType: 'not_a_resource',
          ownerId: fixture.customerId,
        }),
      ).rejects.toMatchObject({ code: 'validation' })

      const rows = await db
        .selectFrom('sys_file')
        .select(db.fn.countAll<string>().as('count'))
        .where('uploaded_by_id', '=', fixture.userId)
        .executeTakeFirstOrThrow()
      expect(Number(rows.count)).toBe(0)
      expect(countObjects(fixture.root)).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  test('公司隔离：列表/下载 fail-closed', async () => {
    const fixture = await createFixture(db)
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    let currencyId = ''
    let companyA = ''
    let companyB = ''
    let journalA = ''
    let journalB = ''
    try {
      currencyId = (
        await db
          .insertInto('bas_currency')
          .values({ name: `附件测试币-${suffix}`, iso_code: `F${suffix.slice(0, 6).toUpperCase()}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      companyA = (
        await db
          .insertInto('bas_company')
          .values({
            code: `FA${suffix}`,
            name: `附件公司甲-${suffix}`,
            short_name: `附件公司甲-${suffix}`,
            base_currency_id: currencyId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      companyB = (
        await db
          .insertInto('bas_company')
          .values({
            code: `FB${suffix}`,
            name: `附件公司乙-${suffix}`,
            short_name: `附件公司乙-${suffix}`,
            base_currency_id: currencyId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      journalA = (
        await db
          .insertInto('acc_gl_journal')
          .values({
            voucher_no: `JA${suffix}`,
            date: new Date().toISOString().slice(0, 10),
            company_id: companyA,
            created_by_id: fixture.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
      journalB = (
        await db
          .insertInto('acc_gl_journal')
          .values({
            voucher_no: `JB${suffix}`,
            date: new Date().toISOString().slice(0, 10),
            company_id: companyB,
            created_by_id: fixture.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id

      const uploader: Actor = {
        userId: fixture.userId,
        username: 'uploader',
        name: null,
        superAdmin: false,
        allCompanies: false,
        permissions: new Set([
          'sys.file:create',
          'sys.file:read',
          'sys.file:delete',
          'acc.gl_journal:read',
        ]),
        companyIds: [companyA, companyB],
      }
      const fileA = await files.upload(uploader, {
        data: new TextEncoder().encode('甲'),
        filename: '甲.txt',
        contentType: 'text/plain',
        ownerType: 'acc_gl_journal',
        ownerId: journalA,
      })
      const fileB = await files.upload(uploader, {
        data: new TextEncoder().encode('乙'),
        filename: '乙.txt',
        contentType: 'text/plain',
        ownerType: 'acc_gl_journal',
        ownerId: journalB,
      })
      fixture.fileIds.push(fileA.file.id, fileB.file.id)
      if (fileA.attachment) fixture.attachmentIds.push(fileA.attachment.id)
      if (fileB.attachment) fixture.attachmentIds.push(fileB.attachment.id)

      const companyAActor: Actor = {
        userId: fixture.userId,
        username: 'a-only',
        name: null,
        superAdmin: false,
        allCompanies: false,
        permissions: new Set(['sys.file:read', 'acc.gl_journal:read']),
        companyIds: [companyA],
      }
      const list = await files.listAttachments(companyAActor, {})
      let sawA = false
      for (const item of list.results) {
        if (item.fileId === fileA.file.id) sawA = true
        if (item.fileId === fileB.file.id || item.companyId === companyB) {
          throw new Error(`company B attachment leaked: ${JSON.stringify(item)}`)
        }
      }
      expect(sawA).toBe(true)
      await files.download(companyAActor, fileA.file.id)
      await expect(files.download(companyAActor, fileB.file.id)).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await sql`DELETE FROM sys_attachment WHERE file_id = ANY(${fixture.fileIds}::uuid[])`.execute(db).catch(() => undefined)
      await sql`DELETE FROM sys_file WHERE id = ANY(${fixture.fileIds}::uuid[])`.execute(db).catch(() => undefined)
      if (journalA || journalB) {
        await sql`DELETE FROM acc_gl_journal WHERE id = ANY(${[journalA, journalB].filter(Boolean)}::uuid[])`.execute(db).catch(() => undefined)
      }
      if (companyA || companyB) {
        await sql`DELETE FROM bas_company WHERE id = ANY(${[companyA, companyB].filter(Boolean)}::uuid[])`.execute(db).catch(() => undefined)
      }
      if (currencyId) {
        await sql`DELETE FROM bas_currency WHERE id = ${currencyId}::uuid`.execute(db).catch(() => undefined)
      }
      fixture.fileIds = []
      fixture.attachmentIds = []
      await fixture.cleanup()
    }
  })

  test('存储接入：密钥 write-only、设默认串行、删默认冲突', async () => {
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    const actor: Actor = {
      userId: crypto.randomUUID(),
      username: 'storage-test',
      name: null,
      superAdmin: true,
      allCompanies: true,
      permissions: new Set(),
      companyIds: [],
    }
    // actor 需存在于 sys_user 才能写审计外键？审计 actor_id 无 FK 强制
    const ids: string[] = []
    let previousDefaultId: string | null = null
    try {
      const prev = await db
        .selectFrom('sys_storage')
        .select('id')
        .where('is_default', '=', true)
        .executeTakeFirst()
      previousDefaultId = prev?.id ?? null

      const localRoot = join('/tmp', `synie-st-${suffix}`)
      mkdirSync(localRoot, { recursive: true })
      const local = await storages.create(actor, {
        name: `l${suffix}`,
        label: '本地测试',
        kind: 'LOCAL',
        root: localRoot,
      })
      ids.push(local.id)
      const secret = 'sk-create'
      const s3 = await storages.create(actor, {
        name: `s${suffix}`,
        label: 'S3 测试',
        kind: 'S3',
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'bucket',
        accessKeyId: 'ak',
        secretAccessKey: secret,
      })
      ids.push(s3.id)
      expect(s3.secretConfigured).toBe(true)
      expect(JSON.stringify(s3)).not.toContain(secret)

      await storages.setDefault(actor, local.id)
      await storages.setDefault(actor, s3.id)
      const localAfter = await storages.get(actor, local.id)
      const s3After = await storages.get(actor, s3.id)
      expect(localAfter.isDefault).toBe(false)
      expect(s3After.isDefault).toBe(true)
      await expect(storages.delete(actor, s3.id)).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${actor.userId}::uuid`.execute(db).catch(() => undefined)
      if (ids.length > 0) {
        await sql`UPDATE sys_storage SET is_default = false WHERE id = ANY(${ids}::uuid[])`.execute(db)
        await sql`DELETE FROM sys_storage WHERE id = ANY(${ids}::uuid[])`.execute(db)
      }
      if (previousDefaultId) {
        await sql`UPDATE sys_storage SET is_default = true WHERE id = ${previousDefaultId}::uuid`.execute(db)
      }
    }
  })

  test('HTTP 路由：上传/元数据/下载/附件查询/存储 CRUD', async () => {
    const fixture = await createFixture(db)
    const app = await buildTestApp()
    const token = await loginToken()
    const authz = { authorization: `Bearer ${token}` }
    try {
      // super_admin 绕过权限；确保默认存储是 fixture
      const form = new FormData()
      form.append('file', new File([new TextEncoder().encode('route-body')], 'route.txt', { type: 'text/plain' }))
      const upload = await app.request('/api/v1/files', { method: 'POST', headers: authz, body: form })
      expect(upload.status).toBe(201)
      const uploaded = (await upload.json()) as {
        file: { id: string; filename: string; size: number; sha256: string }
        attachment: null
      }
      fixture.fileIds.push(uploaded.file.id)
      expect(uploaded.file.filename).toBe('route.txt')
      expect(uploaded.file.size).toBe(10)
      expect(uploaded.file.sha256).toHaveLength(64)
      expect(uploaded.attachment).toBeNull()

      const meta = await app.request(`/api/v1/files/${uploaded.file.id}/metadata`, { headers: authz })
      expect(meta.status).toBe(200)
      expect(((await meta.json()) as { id: string }).id).toBe(uploaded.file.id)

      const dl = await app.request(`/api/v1/files/${uploaded.file.id}`, { headers: authz })
      expect(dl.status).toBe(200)
      expect(await dl.text()).toBe('route-body')
      expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff')

      const query = await app.request('/api/v1/files/query', {
        method: 'POST',
        headers: { ...authz, 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 20, offset: 0, search: 'route' }),
      })
      expect(query.status).toBe(200)
      const list = (await query.json()) as { count: number; results: { id: string }[] }
      expect(list.results.some((r) => r.id === uploaded.file.id)).toBe(true)

      // attach
      const attach = await app.request(`/api/v1/files/${uploaded.file.id}/attachments`, {
        method: 'POST',
        headers: { ...authz, 'content-type': 'application/json' },
        body: JSON.stringify({ ownerType: 'sal_customer', ownerId: fixture.customerId, category: 'doc' }),
      })
      expect(attach.status).toBe(201)
      const attached = (await attach.json()) as { attachment: { id: string } }
      fixture.attachmentIds.push(attached.attachment.id)

      const attQuery = await app.request('/api/v1/files/attachments/query', {
        method: 'POST',
        headers: { ...authz, 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: uploaded.file.id }),
      })
      expect(attQuery.status).toBe(200)
      expect(((await attQuery.json()) as { count: number }).count).toBeGreaterThanOrEqual(1)

      const delAtt = await app.request(`/api/v1/files/attachments/${attached.attachment.id}`, {
        method: 'DELETE',
        headers: authz,
      })
      expect(delAtt.status).toBe(204)
      fixture.attachmentIds = []

      const delFile = await app.request(`/api/v1/files/${uploaded.file.id}`, {
        method: 'DELETE',
        headers: authz,
      })
      expect(delFile.status).toBe(204)
      fixture.fileIds = []

      // storages
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      const root = join('/tmp', `synie-route-st-${suffix}`)
      mkdirSync(root, { recursive: true })
      const createSt = await app.request('/api/v1/system/storages', {
        method: 'POST',
        headers: { ...authz, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `r${suffix}`, label: '路由存储', kind: 'LOCAL', root }),
      })
      expect(createSt.status).toBe(201)
      const st = (await createSt.json()) as { id: string; secretConfigured: boolean; kind: string }
      expect(st.kind).toBe('LOCAL')
      expect(st.secretConfigured).toBe(false)
      expect(JSON.stringify(st)).not.toContain('secretAccessKey')

      const getSt = await app.request(`/api/v1/system/storages/${st.id}`, { headers: authz })
      expect(getSt.status).toBe(200)

      const setDef = await app.request(`/api/v1/system/storages/${st.id}/set-default`, {
        method: 'POST',
        headers: authz,
      })
      expect(setDef.status).toBe(204)

      // 恢复 fixture 为默认再删
      await app.request(`/api/v1/system/storages/${fixture.storageId}/set-default`, {
        method: 'POST',
        headers: authz,
      })
      const delSt = await app.request(`/api/v1/system/storages/${st.id}`, {
        method: 'DELETE',
        headers: authz,
      })
      expect(delSt.status).toBe(204)

      // 无权限用户
      const denied = await app.request('/api/v1/files', {
        method: 'POST',
        body: form,
      })
      expect(denied.status).toBe(401)
    } finally {
      await fixture.cleanup()
    }
  })
})

interface Fixture {
  userId: string
  customerId: string
  storageId: string
  storageName: string
  root: string
  previousDefaultId: string | null
  fileIds: string[]
  attachmentIds: string[]
  cleanup: () => Promise<void>
}

async function createFixture(db: Kysely<Database>): Promise<Fixture> {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const root = join('/tmp', `synie-files-${suffix}`)
  mkdirSync(root, { recursive: true })
  const storageName = `t${suffix}`

  const user = await db
    .insertInto('sys_user')
    .values({
      username: `files_${suffix}`,
      name: '文件测试用户',
      hashed_password: 'test-only',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const customer = await db
    .insertInto('sal_customers')
    .values({ code: `F${suffix}`, name: `文件测试客户-${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow()

  const storage = await db
    .insertInto('sys_storage')
    .values({
      name: storageName,
      label: '文件测试存储',
      kind: 'local',
      root,
      is_default: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const previous = await db
    .selectFrom('sys_storage')
    .select('id')
    .where('is_default', '=', true)
    .executeTakeFirst()

  await db.updateTable('sys_storage').set({ is_default: false }).where('is_default', '=', true).execute()
  await db.updateTable('sys_storage').set({ is_default: true }).where('id', '=', storage.id).execute()

  const fixture: Fixture = {
    userId: user.id,
    customerId: customer.id,
    storageId: storage.id,
    storageName,
    root,
    previousDefaultId: previous?.id ?? null,
    fileIds: [],
    attachmentIds: [],
    cleanup: async () => {
      if (fixture.fileIds.length) {
        await sql`DELETE FROM sys_attachment WHERE file_id = ANY(${fixture.fileIds}::uuid[])`.execute(db).catch(() => undefined)
        await sql`DELETE FROM sys_file WHERE id = ANY(${fixture.fileIds}::uuid[])`.execute(db).catch(() => undefined)
      }
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${fixture.userId}::uuid`.execute(db).catch(() => undefined)
      await db.updateTable('sys_storage').set({ is_default: false }).where('id', '=', fixture.storageId).execute().catch(() => undefined)
      await db.deleteFrom('sys_storage').where('id', '=', fixture.storageId).execute().catch(() => undefined)
      if (fixture.previousDefaultId) {
        await db
          .updateTable('sys_storage')
          .set({ is_default: true })
          .where('id', '=', fixture.previousDefaultId)
          .execute()
          .catch(() => undefined)
      }
      await db.deleteFrom('sal_customers').where('id', '=', fixture.customerId).execute().catch(() => undefined)
      await db.deleteFrom('sys_user').where('id', '=', fixture.userId).execute().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    },
  }
  return fixture
}

function countObjects(root: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) total += countObjects(path)
      else total++
    }
  } catch {
    return 0
  }
  return total
}
