import { describe, expect, test } from 'bun:test'
import type { ConvertRequestV1 } from '@synie/shared'
import { sha256Hex } from './auth'
import type { PdfConverter } from './converter'
import { createPrintWorkerHandler } from './worker'

const xlsx = new TextEncoder().encode('xlsx-fixture')
const pdf = new TextEncoder().encode('%PDF-1.7 fixture')

function wire(jobId = 'job_1'): ConvertRequestV1 {
  return {
    version: 1,
    jobId,
    attempt: 1,
    deadlineAt: Date.now() + 20_000,
    input: { getUrl: 'http://minio/input', size: xlsx.byteLength, sha256: sha256Hex(xlsx) },
    output: { putUrl: 'http://minio/output', headers: { 'content-type': 'application/pdf' } },
  }
}

function request(value: ConvertRequestV1): Request {
  const body = JSON.stringify(value)
  return new Request('http://worker/execute', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
  })
}

function dependencies(converter?: PdfConverter) {
  let uploaded: Uint8Array | undefined
  let uploadHeaders: Headers | undefined
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer())
      uploadHeaders = new Headers(init?.headers)
      return new Response(null, { status: 200 })
    }
    return new Response(xlsx, { headers: { 'content-length': String(xlsx.byteLength) } })
  }
  return {
    deps: {
      converter: converter ?? { convert: async () => pdf, version: async () => 'LibreOffice test' },
      fetch: fakeFetch as typeof fetch,
      authenticate: () => true,
      assertUrl: async (url: string) => new URL(url),
      maxConcurrency: 1,
    },
    uploaded: () => uploaded,
    uploadHeaders: () => uploadHeaders,
  }
}

describe('print worker service', () => {
  test('validates path, downloads/hash-checks, converts and uploads', async () => {
    const fixture = dependencies()
    const handle = createPrintWorkerHandler(fixture.deps)
    const response = await handle(request(wire()), 'job_1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ version: 1, jobId: 'job_1', output: { sha256: sha256Hex(pdf) } })
    expect(fixture.uploaded()).toEqual(pdf)
    expect(fixture.uploadHeaders()?.get('x-amz-checksum-sha256')).toBe(
      Buffer.from(sha256Hex(pdf), 'hex').toString('base64'),
    )
    expect(fixture.uploadHeaders()?.has('x-amz-meta-sha256')).toBe(false)
    const mismatch = await handle(request(wire()), 'different')
    expect(mismatch.status).toBe(400)
  })

  test('authentication failure is uniform and precedes parsing', async () => {
    const fixture = dependencies()
    const handle = createPrintWorkerHandler({ ...fixture.deps, authenticate: () => false })
    const response = await handle(new Request('http://worker', { method: 'POST', body: '{bad' }), 'job_1')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  test('returns busy immediately instead of queueing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fixture = dependencies({
      convert: async () => { await gate; return pdf },
      version: async () => 'LibreOffice test',
    })
    const handle = createPrintWorkerHandler(fixture.deps)
    const first = handle(request(wire('job_1')), 'job_1')
    await Bun.sleep(10)
    const second = await handle(request(wire('job_2')), 'job_2')
    expect(second.status).toBe(503)
    expect(await second.json()).toMatchObject({ error: { code: 'busy' } })
    release()
    expect((await first).status).toBe(200)
  })

  test('rejects hash mismatch before invoking converter', async () => {
    let called = false
    const fixture = dependencies({ convert: async () => { called = true; return pdf }, version: async () => 'x' })
    const handle = createPrintWorkerHandler(fixture.deps)
    const input = wire()
    input.input.sha256 = '0'.repeat(64)
    const response = await handle(request(input), input.jobId)
    expect(response.status).toBe(422)
    expect(called).toBe(false)
  })

  test('rejects a converter result that is not a bounded PDF before upload', async () => {
    const fixture = dependencies({
      convert: async () => new TextEncoder().encode('not a pdf'),
      version: async () => 'x',
    })
    const handle = createPrintWorkerHandler(fixture.deps)
    const response = await handle(request(wire()), 'job_1')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'convert_failed' } })
    expect(fixture.uploaded()).toBeUndefined()
  })
})
