import { afterEach, describe, expect, test } from 'bun:test'
import {
  activateFileSemanticOperations,
  fetchFileBlob,
  queryAttachmentsForFile,
  queryFileAttachments,
  uploadFile,
  type FileSemanticOperations,
} from './files'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function operations(overrides: Partial<FileSemanticOperations> = {}): FileSemanticOperations {
  return {
    createUploadIntent: async () => ({ id: 'intent-1', expiresAt: Date.now() + 60_000 }),
    signUpload: async () => ({ finalized: false, url: 'http://127.0.0.1:9000/synie-product-files/signed', headers: { 'x-amz-checksum-sha256': 'signed' } }),
    finalizeUpload: async () => ({
      file: { id: 'file-1', storage: 's3', key: 'files/object', filename: 'fixture.txt', contentType: 'text/plain', size: 7, sha256: 'hash', insertedAt: '2026-07-31T00:00:00.000Z' },
      attachment: null,
    }),
    downloadUrl: async () => ({ url: 'http://127.0.0.1:9000/signed-download', filename: 'fixture.txt', contentType: 'text/plain' }),
    attach: async () => ({ id: 'attachment-1', fileId: 'file-1', ownerType: 'inv_material', ownerId: 'material-1', category: 'default', insertedAt: '2026-07-31T00:00:00.000Z' }),
    listAttachments: async () => ({ count: 0, results: [] }),
    listFileAttachments: async () => ({ count: 0, results: [] }),
    removeAttachment: async () => undefined,
    removeFile: async () => undefined,
    listFiles: async () => ({ count: 0, results: [] }),
    getFile: async () => null,
    ...overrides,
  }
}

describe('Convex product file seam', () => {
  test('computes SHA-256, signs metadata, and sends bytes only to the S3 URL', async () => {
    const intents: unknown[] = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    activateFileSemanticOperations(operations({
      createUploadIntent: async (input) => {
        intents.push(input)
        return { id: 'intent-direct', expiresAt: Date.now() + 60_000 }
      },
      signUpload: async (id) => {
        expect(id).toBe('intent-direct')
        return { finalized: false, url: 'http://127.0.0.1:9000/synie-product-files/direct', headers: { 'content-type': 'text/plain' } }
      },
      finalizeUpload: async (id) => {
        expect(id).toBe('intent-direct')
        return { file: { id: 'file-direct', storage: 's3', key: 'files/direct', filename: 'fixture.txt', contentType: 'text/plain', size: 7, sha256: 'unused', insertedAt: '2026-07-31T00:00:00.000Z' } }
      },
    }))
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    const fixture = new File(['fixture'], 'fixture.txt', { type: 'text/plain' })
    const expectedHash = Buffer.from(await crypto.subtle.digest('SHA-256', await fixture.arrayBuffer())).toString('hex')
    const result = await uploadFile(fixture, {
      ownerType: 'inv_material', ownerId: 'material-1', category: 'image',
    })

    expect(result.file.id).toBe('file-direct')
    expect(intents).toEqual([{
      filename: 'fixture.txt', contentType: fixture.type, size: 7,
      sha256: expectedHash,
      ownerType: 'inv_material', ownerId: 'material-1', category: 'image',
    }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:9000/synie-product-files/direct')
    expect(requests[0]?.init?.method).toBe('PUT')
    expect(requests[0]?.init?.body).toBeInstanceOf(File)
  })

  test('download and both attachment query shapes stay behind the same seam', async () => {
    const calls: string[] = []
    activateFileSemanticOperations(operations({
      downloadUrl: async () => ({ url: 'http://127.0.0.1:9000/download', filename: 'a.txt', contentType: 'text/plain' }),
      listAttachments: async () => { calls.push('owner'); return { count: 0, results: [] } },
      listFileAttachments: async () => { calls.push('file'); return { count: 0, results: [] } },
    }))
    globalThis.fetch = (async () => new Response('bytes', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch

    expect(await (await fetchFileBlob('file-1')).text()).toBe('bytes')
    await queryFileAttachments({ ownerType: 'inv_material', ownerId: 'material-1' })
    await queryAttachmentsForFile('file-1')
    expect(calls).toEqual(['owner', 'file'])
  })
})
