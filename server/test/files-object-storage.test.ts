import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createLocalStorage,
  createS3Storage,
  parseListObjectsXml,
  safeExtension,
} from '~/platform/files/object-storage.ts'

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

  test('list 递归列出相对 key（posix 形态）与修改时间', async () => {
    const root = join('/tmp', `synie-local-list-${crypto.randomUUID()}`)
    mkdirSync(root, { recursive: true })
    const store = createLocalStorage(root)
    const source = join(root, 'source.bin')
    writeFileSync(source, 'x')

    await store.put('2026/08/a.bin', source)
    await store.put('2026/08/07/b.bin', source)

    const objects = await store.list()
    const keys = objects.map((o) => o.key).sort()
    // source.bin 在根目录也会被列出（调用方以 sys_file 行为准比对）
    expect(keys).toEqual(['2026/08/07/b.bin', '2026/08/a.bin', 'source.bin'])
    for (const o of objects) expect(o.modifiedAt).toBeInstanceOf(Date)
  })
})

describe('parseListObjectsXml', () => {
  test('提取 Key/LastModified/翻页字段并反转义', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok&amp;1</NextContinuationToken>
  <Contents><Key>2026/08/a&lt;b.bin</Key><LastModified>2026-08-07T19:00:00.000Z</LastModified></Contents>
  <Contents><Key>2026/08/c.bin</Key><LastModified>2026-08-08T01:00:00.000Z</LastModified></Contents>
</ListBucketResult>`
    const page = parseListObjectsXml(xml)
    expect(page.truncated).toBe(true)
    expect(page.nextToken).toBe('tok&1')
    expect(page.items.map((i) => i.key)).toEqual(['2026/08/a<b.bin', '2026/08/c.bin'])
    expect(page.items[0]!.modifiedAt?.toISOString()).toBe('2026-08-07T19:00:00.000Z')
  })

  test('未截断且无 token', () => {
    const page = parseListObjectsXml(
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key></Contents></ListBucketResult>',
    )
    expect(page.truncated).toBe(false)
    expect(page.nextToken).toBeNull()
    expect(page.items[0]!.modifiedAt).toBeNull()
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
