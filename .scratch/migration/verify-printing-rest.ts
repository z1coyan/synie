import { SQL } from 'bun'

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin'
const password = process.env.E2E_ADMIN_PASSWORD ?? 'synie-integration-admin-password'
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  'postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable'
const fixture = 'backend/apps/synie_web/test/support/fixtures/matrix_template.xlsx'

async function api<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(baseURL + path, init)
  const text = await response.text()
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}, ${text}`)
  }
  return text === '' ? (undefined as T) : (JSON.parse(text) as T)
}

const login = await api<{ token: string }>('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
const headers = {
  Authorization: `Bearer ${login.token}`,
  'Content-Type': 'application/json',
}
const db = new SQL(databaseURL)
let templateID: string | null = null
let fileID: string | null = null
/** 本脚本自建的默认本地存储（空库自愈）；不删，避免与后续上传竞态 */
let seededStorage = false

try {
  // 空库无 setup 时 files 上传依赖默认接入点；幂等预置 local
  const storages = (await db`
    SELECT id::text AS id FROM sys_storage WHERE is_default = true LIMIT 1
  `) as Array<{ id: string }>
  if (!storages[0]) {
    await db`
      INSERT INTO sys_storage (name, label, kind, root, builtin, is_default)
      SELECT 'local', '本地存储', 'local', 'uploads', true, true
      WHERE NOT EXISTS (SELECT 1 FROM sys_storage WHERE name = 'local')
    `
    // 若 name=local 已存在但非默认，升为默认
    await db`
      UPDATE sys_storage SET is_default = true, updated_at = (now() AT TIME ZONE 'utc')
      WHERE name = 'local' AND NOT EXISTS (SELECT 1 FROM sys_storage WHERE is_default)
    `
    seededStorage = true
  }

  const [meta, resources, catalog] = await Promise.all([
    api<{ grid: { capabilities: string[]; destroyMutation?: string | null } }>(
      '/meta/resources/sysPrintTemplates',
      { headers },
    ),
    api<{ resources: string[] }>('/printing/resources', { headers }),
    api<{ fields: unknown[]; loops: unknown[] }>(
      '/printing/field-catalog?resource=sales.order',
      { headers },
    ),
  ])
  if ([...meta.grid.capabilities].sort().join(',') !== 'create,delete,update') {
    throw new Error(`capabilities=${meta.grid.capabilities.join(',')}`)
  }
  if (meta.grid.destroyMutation !== 'destroySysPrintTemplate') {
    throw new Error(`destroyMutation=${meta.grid.destroyMutation}`)
  }
  if (resources.resources.length !== 60 || !resources.resources.includes('sales.order')) {
    throw new Error(`resources=${resources.resources.length}`)
  }
  if (catalog.fields.length !== 25 || catalog.loops.length !== 1) {
    throw new Error(`sales.order catalog=${catalog.fields.length}/${catalog.loops.length}`)
  }

  const form = new FormData()
  form.append(
    'file',
    Bun.file(fixture),
    `REST打印模板-${crypto.randomUUID().slice(0, 8)}.xlsx`,
  )
  const uploadResponse = await fetch(baseURL + '/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` },
    body: form,
  })
  if (uploadResponse.status !== 201) {
    throw new Error(`upload=${uploadResponse.status}:${await uploadResponse.text()}`)
  }
  const uploaded = (await uploadResponse.json()) as { file: { id: string } }
  fileID = uploaded.file.id

  const suffix = crypto.randomUUID().slice(0, 8)
  const created = await api<{
    id: string
    resource: string
    isDefault: boolean
  }>(
    '/system/printing/templates',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `REST打印验收-${suffix}`,
        resource: 'sales.order',
        fileId: fileID,
        remarks: '初版',
      }),
    },
    201,
  )
  templateID = created.id
  if (created.resource !== 'sales.order' || created.isDefault) {
    throw new Error('create result mismatch')
  }

  const listed = await api<{ count: number; results: Array<{ id: string }> }>(
    '/system/printing/templates/query',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 20, offset: 0, search: suffix }),
    },
  )
  if (listed.count !== 1 || listed.results[0]?.id !== templateID) {
    throw new Error('query result mismatch')
  }
  const usable = await api<{ results: Array<{ id: string }> }>(
    '/printing/templates?resource=sales.order',
    { headers },
  )
  if (!usable.results.some((item) => item.id === templateID)) {
    throw new Error('usable template missing')
  }
  const defaulted = await api<{ isDefault: boolean }>(
    `/system/printing/templates/${templateID}/set-default`,
    { method: 'POST', headers },
  )
  if (!defaulted.isDefault) throw new Error('set-default failed')
  const unset = await api<{ isDefault: boolean }>(
    `/system/printing/templates/${templateID}/unset-default`,
    { method: 'POST', headers },
  )
  if (unset.isDefault) throw new Error('unset-default failed')
  const updated = await api<{ name: string; remarks?: string | null }>(
    `/system/printing/templates/${templateID}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: `REST打印已更新-${suffix}`, remarks: null }),
    },
  )
  if (!updated.name.includes('已更新') || updated.remarks != null) {
    throw new Error('update result mismatch')
  }

  const attachments = await db`
    SELECT count(*)::int AS count
    FROM sys_attachment
    WHERE owner_type = 'sys_print_template'
      AND owner_id = ${templateID}::uuid
      AND file_id = ${fileID}::uuid
      AND category = 'template'
      AND company_id IS NULL
  `
  if (Number(attachments[0].count) !== 1) {
    throw new Error(`attachments=${attachments[0].count}`)
  }
  await api<void>(
    `/system/printing/templates/${templateID}`,
    { method: 'DELETE', headers },
    204,
  )
  const [auditRows, fileRows] = await Promise.all([
    db`
      SELECT count(*)::int AS count FROM sys_audit_log
      WHERE resource = 'sys_print_template' AND record_id = ${templateID}::uuid
    `,
    db`SELECT count(*)::int AS count FROM sys_file WHERE id = ${fileID}::uuid`,
  ])
  if (Number(auditRows[0].count) !== 5) {
    throw new Error(`audit=${auditRows[0].count}, want 5`)
  }
  if (Number(fileRows[0].count) !== 1) throw new Error('template delete removed file')

  // 渲染出口：模板 CRUD 后另建一份模板，对真实销售订单做 export/print 冒烟
  const orderRows = await db`
    SELECT id::text AS id, order_no
    FROM sal_order
    ORDER BY inserted_at DESC
    LIMIT 1
  `
  let renderNote = 'render=skipped(no sal_order)'
  if (orderRows[0]?.id) {
    const renderForm = new FormData()
    renderForm.append(
      'file',
      Bun.file(fixture),
      `REST打印渲染-${crypto.randomUUID().slice(0, 8)}.xlsx`,
    )
    const renderUpload = await fetch(baseURL + '/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: renderForm,
    })
    if (renderUpload.status !== 201) {
      throw new Error(`render upload=${renderUpload.status}:${await renderUpload.text()}`)
    }
    const renderFile = (await renderUpload.json()) as { file: { id: string } }
    const renderTpl = await api<{ id: string }>(
      '/system/printing/templates',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `REST渲染验收-${suffix}`,
          resource: 'sales.order',
          fileId: renderFile.file.id,
        }),
      },
      201,
    )
    for (const mode of ['export', 'print'] as const) {
      const res = await fetch(baseURL + '/printing/render', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          resource: 'sales.order',
          mode,
          templateId: renderTpl.id,
          ids: [orderRows[0].id],
        }),
      })
      const buf = await res.arrayBuffer()
      if (!res.ok) {
        throw new Error(`render ${mode}=${res.status}:${new TextDecoder().decode(buf)}`)
      }
      if (buf.byteLength < 100) {
        throw new Error(`render ${mode} empty body (${buf.byteLength} bytes)`)
      }
      const ct = res.headers.get('content-type') ?? ''
      if (mode === 'export' && !ct.includes('spreadsheetml')) {
        throw new Error(`render export content-type=${ct}`)
      }
      if (mode === 'print' && !ct.includes('pdf')) {
        throw new Error(`render print content-type=${ct}`)
      }
    }
    await api<void>(
      `/system/printing/templates/${renderTpl.id}`,
      { method: 'DELETE', headers },
      204,
    )
    await api<void>(`/files/${renderFile.file.id}`, { method: 'DELETE', headers }, 204)
    renderNote = `render=export+print order=${orderRows[0].order_no}`
  }

  templateID = null
  await api<void>(`/files/${fileID}`, { method: 'DELETE', headers }, 204)
  await db`
    DELETE FROM sys_audit_log
    WHERE record_id = ${created.id}::uuid OR record_id = ${fileID}::uuid
  `
  fileID = null
  console.log(
    `printing REST acceptance ok: resources=60 salesOrderFields=25 template=${created.id} ${renderNote}`,
  )
} finally {
  if (templateID) {
    await fetch(baseURL + `/system/printing/templates/${templateID}`, {
      method: 'DELETE',
      headers,
    })
  }
  if (fileID) {
    await fetch(baseURL + `/files/${fileID}`, { method: 'DELETE', headers })
  }
  await db.close()
}
