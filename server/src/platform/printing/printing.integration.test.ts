/**
 * 打印模板 REST 集成测试（门控 SYNIE_TEST_DATABASE_URL）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strToU8, zipSync } from 'fflate'
import { createDb } from '~/db/index.ts'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { buildTestApp, testDatabaseUrl } from '../../../test/helpers.ts'
import type { ApiType } from '~/app.ts'

const dbUrl = testDatabaseUrl()
const describeIf = dbUrl ? describe : describe.skip

function minimalValidTemplate(nonce = crypto.randomUUID()): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="T" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>\${order_no}</t></is></c><c r="B1" t="inlineStr"><is><t>${nonce}</t></is></c></row></sheetData></worksheet>`,
    ),
  })
}

describeIf('printing integration', () => {
  let db: Kysely<Database>
  let app: ApiType
  let token: string
  let fileId: string | null = null
  let templateId: string | null = null

  beforeAll(async () => {
    db = createDb(dbUrl!)
    // 确保有默认本地存储（上传模板文件需要）
    const existing = await db
      .selectFrom('sys_storage')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirst()
    if (!existing) {
      const root = join(tmpdir(), `synie-print-it-${crypto.randomUUID().slice(0, 8)}`)
      mkdirSync(root, { recursive: true })
      await db
        .insertInto('sys_storage')
        .values({
          name: `print_it_${crypto.randomUUID().slice(0, 6)}`,
          label: '打印集成默认存储',
          kind: 'local',
          root,
          is_default: true,
        })
        .execute()
    }
    app = await buildTestApp(db)

    const tryLogin = async (username: string, password: string) => {
      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) return null
      return (await res.json()) as { token: string }
    }

    let body =
      (await tryLogin(
        process.env.E2E_ADMIN_USERNAME ?? 'admin',
        process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      )) ?? (await tryLogin('admin', 'admin123'))

    // 共享库可能被 setup 截断；自建超管
    if (!body) {
      const { hashPassword } = await import('~/platform/auth/password.ts')
      const password = 'admin123'
      const hashed = await hashPassword(password)
      await db
        .insertInto('sys_user')
        .values({
          username: 'admin',
          name: 'print-integration-admin',
          hashed_password: hashed,
          super_admin: true,
          all_companies: true,
        })
        .onConflict((oc) =>
          oc.column('username').doUpdateSet({
            hashed_password: hashed,
            super_admin: true,
            all_companies: true,
          }),
        )
        .execute()
      body = await tryLogin('admin', password)
    }
    if (!body) throw new Error('login failed after admin self-heal')
    token = body.token
  })

  afterAll(async () => {
    if (templateId) {
      await app.request(`/api/v1/system/printing/templates/${templateId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
    if (fileId) {
      await app.request(`/api/v1/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
    await db.destroy()
  })

  test('meta + catalog + template CRUD', async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    const metaRes = await app.request('/api/v1/meta/resources/sysPrintTemplates', { headers })
    expect(metaRes.status).toBe(200)
    const meta = (await metaRes.json()) as {
      schemaVersion: number
      name: string
      capabilities: string[]
    }
    expect(meta.schemaVersion).toBe(2)
    expect(meta.name).toBe('sysPrintTemplates')
    expect([...meta.capabilities].sort().join(',')).toBe('create,delete,update')

    const resourcesRes = await app.request('/api/v1/printing/resources', { headers })
    expect(resourcesRes.status).toBe(200)
    const resources = (await resourcesRes.json()) as { resources: string[] }
    expect(resources.resources.length).toBe(61)
    expect(resources.resources).toContain('sales.order')

    const catalogRes = await app.request(
      '/api/v1/printing/field-catalog?resource=sales.order',
      { headers },
    )
    expect(catalogRes.status).toBe(200)
    const catalog = (await catalogRes.json()) as { fields: unknown[]; loops: unknown[] }
    expect(catalog.fields.length).toBe(25)
    expect(catalog.loops.length).toBe(1)

    const form = new FormData()
    const bytes = minimalValidTemplate()
    form.append(
      'file',
      new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      `print-test-${crypto.randomUUID().slice(0, 8)}.xlsx`,
    )
    const uploadRes = await app.request('/api/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(uploadRes.status).toBe(201)
    const uploaded = (await uploadRes.json()) as { file: { id: string } }
    fileId = uploaded.file.id

    const suffix = crypto.randomUUID().slice(0, 8)
    const createRes = await app.request('/api/v1/system/printing/templates', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `集成打印-${suffix}`,
        resource: 'sales.order',
        fileId,
        remarks: '初版',
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as {
      id: string
      resource: string
      isDefault: boolean
    }
    templateId = created.id
    expect(created.resource).toBe('sales.order')
    expect(created.isDefault).toBe(false)

    const queryRes = await app.request('/api/v1/system/printing/templates/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 20, offset: 0, search: suffix }),
    })
    expect(queryRes.status).toBe(200)
    const listed = (await queryRes.json()) as { count: number; results: Array<{ id: string }> }
    expect(listed.count).toBe(1)
    expect(listed.results[0]?.id).toBe(templateId)

    const usableRes = await app.request('/api/v1/printing/templates?resource=sales.order', {
      headers,
    })
    expect(usableRes.status).toBe(200)
    const usable = (await usableRes.json()) as { results: Array<{ id: string }> }
    expect(usable.results.some((item) => item.id === templateId)).toBe(true)

    const defaultRes = await app.request(
      `/api/v1/system/printing/templates/${templateId}/set-default`,
      { method: 'POST', headers },
    )
    expect(defaultRes.status).toBe(200)
    expect(((await defaultRes.json()) as { isDefault: boolean }).isDefault).toBe(true)

    const unsetRes = await app.request(
      `/api/v1/system/printing/templates/${templateId}/unset-default`,
      { method: 'POST', headers },
    )
    expect(unsetRes.status).toBe(200)
    expect(((await unsetRes.json()) as { isDefault: boolean }).isDefault).toBe(false)

    const updateRes = await app.request(`/api/v1/system/printing/templates/${templateId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: `已更新-${suffix}`, remarks: null }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as { name: string; remarks?: string | null }
    expect(updated.name).toContain('已更新')
    expect(updated.remarks).toBeNull()

    const attachments = await db
      .selectFrom('sys_attachment')
      .select(db.fn.countAll<string>().as('count'))
      .where('owner_type', '=', 'sys_print_template')
      .where('owner_id', '=', templateId)
      .where('file_id', '=', fileId)
      .where('category', '=', 'template')
      .executeTakeFirstOrThrow()
    expect(Number(attachments.count)).toBe(1)

    const delRes = await app.request(`/api/v1/system/printing/templates/${templateId}`, {
      method: 'DELETE',
      headers,
    })
    expect(delRes.status).toBe(204)

    const audit = await db
      .selectFrom('sys_audit_log')
      .select(db.fn.countAll<string>().as('count'))
      .where('resource', '=', 'sys_print_template')
      .where('record_id', '=', templateId)
      .executeTakeFirstOrThrow()
    expect(Number(audit.count)).toBe(5)

    const fileStill = await db
      .selectFrom('sys_file')
      .select(db.fn.countAll<string>().as('count'))
      .where('id', '=', fileId)
      .executeTakeFirstOrThrow()
    expect(Number(fileStill.count)).toBe(1)

    const deletedId = templateId
    templateId = null

    const fileDel = await app.request(`/api/v1/files/${fileId}`, {
      method: 'DELETE',
      headers,
    })
    expect(fileDel.status).toBe(204)
    await db
      .deleteFrom('sys_audit_log')
      .where('record_id', 'in', [deletedId!, fileId])
      .execute()
    fileId = null
  })
})
