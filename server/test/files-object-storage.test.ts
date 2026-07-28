import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalStorage, createS3Storage, safeExtension } from '~/platform/files/object-storage.ts'

describe('safeExtension', () => {
  test('白名单扩展名小写；非法/路径穿越为空', () => {
    expect(safeExtension('合同.PDF')).toBe('.pdf')
    expect(safeExtension('photo.jpeg')).toBe('.jpeg')
    expect(safeExtension('evil.sh/../../x')).toBe('')
    expect(safeExtension('too.abcdefghijk')).toBe('')
    expect(safeExtension('无扩展名')).toBe('')
  })
})

describe('LocalStorage', () => {
  test('读写删除往返 + 路径穿越拒绝', async () => {
    const root = join('/tmp', `synie-local-${crypto.randomUUID()}`)
    mkdirSync(root, { recursive: true })
    const store = createLocalStorage(root)
    const source = join(root, 'source.bin')
    writeFileSync(source, '文件字节')

    await store.put('2026/07/id.bin', source)
    const got = await store.read('2026/07/id.bin')
    expect(new TextDecoder().decode(got)).toBe('文件字节')

    await store.delete('2026/07/id.bin')
    await store.delete('2026/07/id.bin') // 幂等

    await expect(store.put('../escape.bin', source)).rejects.toThrow()
  })
})

describe('S3Storage.presignedGet', () => {
  test('保留配置 prefix 并产出 SigV4 签名查询串', async () => {
    const store = createS3Storage({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'synie-files',
      prefix: '/tenant-a/',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      kind: 's3',
    })
    const signed = await store.presignedGet('/2026/07/合同.pdf', 5 * 60 * 1000)
    const parsed = new URL(signed)
    expect(parsed.host).toBe('127.0.0.1:9000')
    expect(parsed.pathname).toContain('/synie-files/tenant-a/2026/07/')
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })
})
