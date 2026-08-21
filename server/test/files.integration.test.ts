import { testActor, type TestActorInput } from '~/platform/authz/testing.ts'
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
import { createActorAssembler, createAuthzStore } from '~/platform/authz/index.ts'
import { createTokenManager } from '~/platform/auth/token.ts'
import { createAuthzEnforcer } from '~/platform/authz/enforce.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { onError, notFound } from '~/platform/http/errors.ts'
import type { AppEnv } from '~/platform/http/context.ts'
import { createSealedResourceRegistry } from '~/platform/meta/register-all.ts'
import {
  ATTACHMENT_RESOURCE_NAME,
  FILE_RESOURCE_NAME,
  STORAGE_RESOURCE_NAME,
  createFileService,
  createOwnerRegistry,
  createStorageService,
  fileRoutes,
  storageRoutes,
} from '~/platform/files/index.ts'
import { ensureAdmin } from '../db/seed-admin.ts'

/**
 * files / storages PG 集成 + 路由测试。
 * 门控 SYNIE_TEST_DATABASE_URL（未设置则整组 Skip）。
 *
 * 可达性语义（工单 06）：孤儿文件走文件自身行过滤（owner=上传者 → self 范围），
 * 已挂接文件随业务宿主；码不满足 forbidden，行级不可达 not_found。
 */
const url = process.env.SYNIE_TEST_DATABASE_URL
const run = url ? describe : describe.skip

run('PG 集成（files / storages）', () => {
  const db = createDb(url!)
  const registry = createSealedResourceRegistry()
  const authz = createAuthzEnforcer(registry)
  // 宿主用现成的廉价表：客户=全局宿主，会计凭证=公司域宿主（生产由 meta.attachments 派生）
  const owners = createOwnerRegistry()
  owners.register('sal_customer', { resource: 'salCustomers', table: 'sal_customers' })
  owners.register('acc_gl_journal', { resource: 'accGlJournals', table: 'acc_gl_journal' })

  const files = createFileService({ db, owners, authz })
  const storages = createStorageService({ db, authz })

  /** 取一张真凭证（走 decide，与路由 guard 同一路径） */
  function permitOf(resource: string, action: string, input: TestActorInput): Permit {
    const decision = authz.decideFor(testActor(input), resource, action)
    if (decision.outcome !== 'permit') throw new Error(`夹具应当 permit: ${resource}:${action}`)
    return decision.permit
  }
  const filePermit = (action: string, input: TestActorInput) =>
    permitOf(FILE_RESOURCE_NAME, action, input)
  const attachmentPermit = (action: string, input: TestActorInput) =>
    permitOf(ATTACHMENT_RESOURCE_NAME, action, input)
  const storagePermit = (action: string, input: TestActorInput) =>
    permitOf(STORAGE_RESOURCE_NAME, action, input)

  const authPromise = createAuthService({
    db,
    store: createAuthStore(db),
    actors: createActorAssembler({
      store: createAuthzStore(db),
      allPermissionCodes: () => registry.allPermissionCodes(),
      ttlMs: 0,
    }),
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
      .route('/files', fileRoutes({ auth, authz, files }))
      .route('/system/storages', storageRoutes({ auth, authz, storages }))
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
      // 常规配置：文件读写授 self 范围（只碰本人上传的孤儿文件）+ 宿主读码
      const owner: TestActorInput = {
        userId: fixture.userId,
        username: 'files-test',
        name: '文件测试',
        scopes: {
          'sys.file:create': ['self'],
          'sys.file:read': ['self'],
          'sys.file:delete': ['self'],
          'base.customer:read': ['all'],
        },
      }

      const payload = new TextEncoder().encode('PDF 内容')
      const uploaded = await files.upload(filePermit('create', owner), {
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

      // 他人的孤儿文件：码满足但行级不命中 → not_found（不泄露存在性）
      const other: TestActorInput = {
        userId: crypto.randomUUID(),
        username: 'other',
        scopes: { 'sys.file:read': ['self'] },
      }
      await expect(
        files.download(filePermit('read', other), uploaded.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })

      const dl = await files.download(filePermit('read', owner), uploaded.file.id)
      expect(new TextDecoder().decode(dl.content)).toBe('PDF 内容')

      const attachment = await files.attach(attachmentPermit('create', owner), uploaded.file.id, {
        ownerType: 'sal_customer',
        ownerId: fixture.customerId,
        category: 'contract',
      })
      fixture.attachmentIds.push(attachment.id)
      expect(attachment.category).toBe('contract')
      expect(attachment.companyId).toBeNull()

      await expect(
        files.deleteFile(filePermit('delete', owner), uploaded.file.id),
      ).rejects.toMatchObject({ code: 'conflict' })

      await files.deleteAttachment(attachmentPermit('delete', owner), attachment.id)
      fixture.attachmentIds = []
      await files.deleteFile(filePermit('delete', owner), uploaded.file.id)
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
      const actor = filePermit('create', {
        userId: fixture.userId,
        username: 'files-test',
        permissions: ['sys.file:create'],
      })
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

      const uploader: TestActorInput = {
        userId: fixture.userId,
        username: 'uploader',
        companyIds: [companyA, companyB],
        scopes: {
          'sys.file:create': ['self'],
          'sys.file:read': ['self'],
          'sys.file:delete': ['self'],
          'acc.gl_journal:read': ['all'],
        },
      }
      const fileA = await files.upload(filePermit('create', uploader), {
        data: new TextEncoder().encode('甲'),
        filename: '甲.txt',
        contentType: 'text/plain',
        ownerType: 'acc_gl_journal',
        ownerId: journalA,
      })
      const fileB = await files.upload(filePermit('create', uploader), {
        data: new TextEncoder().encode('乙'),
        filename: '乙.txt',
        contentType: 'text/plain',
        ownerType: 'acc_gl_journal',
        ownerId: journalB,
      })
      fixture.fileIds.push(fileA.file.id, fileB.file.id)
      if (fileA.attachment) fixture.attachmentIds.push(fileA.attachment.id)
      if (fileB.attachment) fixture.attachmentIds.push(fileB.attachment.id)

      const companyAActor: TestActorInput = {
        userId: fixture.userId,
        username: 'a-only',
        companyIds: [companyA],
        scopes: { 'sys.file:read': ['self'], 'acc.gl_journal:read': ['all'] },
      }
      const list = await files.listAttachments(attachmentPermit('read', companyAActor), {})
      let sawA = false
      for (const item of list.results) {
        if (item.fileId === fileA.file.id) sawA = true
        if (item.fileId === fileB.file.id || item.companyId === companyB) {
          throw new Error(`company B attachment leaked: ${JSON.stringify(item)}`)
        }
      }
      expect(sawA).toBe(true)
      await files.download(filePermit('read', companyAActor), fileA.file.id)
      // 跨公司宿主：宿主行不可达 → not_found（原 forbidden）
      await expect(
        files.download(filePermit('read', companyAActor), fileB.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        files.get(filePermit('read', companyAActor), fileB.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      // 上传者本人也不例外：文件已挂宿主，可达性由宿主接管
      await expect(
        files.download(filePermit('read', { ...uploader, companyIds: [companyA] }), fileB.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      // 无宿主 read 码：码级判定过（sys.file:read 在手），宿主不可达 → not_found
      const noHostCode: TestActorInput = {
        userId: fixture.userId,
        username: 'no-host-code',
        companyIds: [companyA, companyB],
        scopes: { 'sys.file:read': ['self'], 'sys.file:create': ['self'] },
      }
      await expect(
        files.download(filePermit('read', noHostCode), fileA.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      expect((await files.listAttachments(attachmentPermit('read', noHostCode), {})).count).toBe(0)
      // 挂接侧相反：宿主码不满足是 forbidden
      const orphan = await files.upload(filePermit('create', noHostCode), {
        data: new TextEncoder().encode('孤儿'),
        filename: '孤儿.txt',
        contentType: 'text/plain',
      })
      fixture.fileIds.push(orphan.file.id)
      await expect(
        files.attach(attachmentPermit('create', noHostCode), orphan.file.id, {
          ownerType: 'acc_gl_journal',
          ownerId: journalA,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      // 孤儿文件仅上传者可见（self 范围）：他人 read 不命中
      expect((await files.get(filePermit('read', noHostCode), orphan.file.id)).id).toBe(
        orphan.file.id,
      )
      const stranger: TestActorInput = {
        userId: crypto.randomUUID(),
        username: 'stranger',
        scopes: { 'sys.file:read': ['self'] },
      }
      await expect(
        files.get(filePermit('read', stranger), orphan.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      const strangerList = await files.list(filePermit('read', stranger), { limit: 200 })
      expect(strangerList.results.some((f) => f.id === orphan.file.id)).toBe(false)
      // 挂接固化宿主公司；宿主为全局资源时为 null
      expect(fileA.attachment?.companyId).toBe(companyA)
      // 跨域读（原 finance requireAccessibleFile）：可达才给字节
      const uploaderActor = testActor(noHostCode)
      expect(
        new TextDecoder().decode((await files.readReachableFile(uploaderActor, orphan.file.id)).content),
      ).toBe('孤儿')
      await expect(
        files.readReachableFile(testActor(stranger), orphan.file.id),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        files.readReachableFile(testActor({ userId: fixture.userId, scopes: {} }), orphan.file.id),
      ).rejects.toMatchObject({ code: 'forbidden' })
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
    const admin: TestActorInput = {
      userId: crypto.randomUUID(),
      username: 'storage-test',
      superAdmin: true,
      allCompanies: true,
    }
    const actorId = admin.userId!
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
      const local = await storages.create(storagePermit('create', admin), {
        name: `l${suffix}`,
        label: '本地测试',
        kind: 'LOCAL',
        root: localRoot,
      })
      ids.push(local.id)
      const secret = 'sk-create'
      const s3 = await storages.create(storagePermit('create', admin), {
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

      await storages.setDefault(storagePermit('update', admin), local.id)
      await storages.setDefault(storagePermit('update', admin), s3.id)
      const localAfter = await storages.get(storagePermit('read', admin), local.id)
      const s3After = await storages.get(storagePermit('read', admin), s3.id)
      expect(localAfter.isDefault).toBe(false)
      expect(s3After.isDefault).toBe(true)
      await expect(
        storages.delete(storagePermit('delete', admin), s3.id),
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      await sql`DELETE FROM sys_audit_log WHERE actor_id = ${actorId}::uuid`.execute(db).catch(() => undefined)
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
    const bearer = { authorization: `Bearer ${token}` }
    try {
      // super_admin 绕过权限；确保默认存储是 fixture
      const form = new FormData()
      form.append('file', new File([new TextEncoder().encode('route-body')], 'route.txt', { type: 'text/plain' }))
      const upload = await app.request('/api/v1/files', { method: 'POST', headers: bearer, body: form })
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

      const meta = await app.request(`/api/v1/files/${uploaded.file.id}/metadata`, { headers: bearer })
      expect(meta.status).toBe(200)
      expect(((await meta.json()) as { id: string }).id).toBe(uploaded.file.id)

      const dl = await app.request(`/api/v1/files/${uploaded.file.id}`, { headers: bearer })
      expect(dl.status).toBe(200)
      expect(await dl.text()).toBe('route-body')
      expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff')

      const query = await app.request('/api/v1/files/query', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 20, offset: 0, search: 'route' }),
      })
      expect(query.status).toBe(200)
      const list = (await query.json()) as { count: number; results: { id: string }[] }
      expect(list.results.some((r) => r.id === uploaded.file.id)).toBe(true)

      // attach
      const attach = await app.request(`/api/v1/files/${uploaded.file.id}/attachments`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ ownerType: 'sal_customer', ownerId: fixture.customerId, category: 'doc' }),
      })
      expect(attach.status).toBe(201)
      const attached = (await attach.json()) as { attachment: { id: string } }
      fixture.attachmentIds.push(attached.attachment.id)

      const attQuery = await app.request('/api/v1/files/attachments/query', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: uploaded.file.id }),
      })
      expect(attQuery.status).toBe(200)
      expect(((await attQuery.json()) as { count: number }).count).toBeGreaterThanOrEqual(1)

      const delAtt = await app.request(`/api/v1/files/attachments/${attached.attachment.id}`, {
        method: 'DELETE',
        headers: bearer,
      })
      expect(delAtt.status).toBe(204)
      fixture.attachmentIds = []

      const delFile = await app.request(`/api/v1/files/${uploaded.file.id}`, {
        method: 'DELETE',
        headers: bearer,
      })
      expect(delFile.status).toBe(204)
      fixture.fileIds = []

      // storages
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      const root = join('/tmp', `synie-route-st-${suffix}`)
      mkdirSync(root, { recursive: true })
      const createSt = await app.request('/api/v1/system/storages', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `r${suffix}`, label: '路由存储', kind: 'LOCAL', root }),
      })
      expect(createSt.status).toBe(201)
      const st = (await createSt.json()) as { id: string; secretConfigured: boolean; kind: string }
      expect(st.kind).toBe('LOCAL')
      expect(st.secretConfigured).toBe(false)
      expect(JSON.stringify(st)).not.toContain('secretAccessKey')

      const getSt = await app.request(`/api/v1/system/storages/${st.id}`, { headers: bearer })
      expect(getSt.status).toBe(200)

      const setDef = await app.request(`/api/v1/system/storages/${st.id}/set-default`, {
        method: 'POST',
        headers: bearer,
      })
      expect(setDef.status).toBe(204)

      // 恢复 fixture 为默认再删
      await app.request(`/api/v1/system/storages/${fixture.storageId}/set-default`, {
        method: 'POST',
        headers: bearer,
      })
      const delSt = await app.request(`/api/v1/system/storages/${st.id}`, {
        method: 'DELETE',
        headers: bearer,
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
