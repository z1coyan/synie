import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillEachDoc, parseBackfillCliArgs } from './backfill-cli.ts'
import { resolveBackfillDatabaseUrl } from './bootstrap.ts'

const dir = mkdtempSync(join(tmpdir(), 'backfill-cli-'))
const idsPath = join(dir, 'ids.txt')
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
writeFileSync(idsPath, `# comment\n${a}\n\n${b}\n${a}\n`)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseBackfillCliArgs', () => {
  test('缺省 dry-run，读 uuid 列表并去重', () => {
    const args = parseBackfillCliArgs(['--kind', 'invoice', '--ids-file', idsPath])
    expect(args.kind).toBe('invoice')
    expect(args.apply).toBe(false)
    expect(args.ids).toEqual([a, b])
  })

  test('--apply 才写；三种 kind', () => {
    expect(parseBackfillCliArgs(['--kind', 'bill', '--ids-file', idsPath, '--apply']).apply).toBe(true)
    expect(parseBackfillCliArgs(['--kind', 'delivery-remain', '--ids-file', idsPath, '--dry-run']).kind).toBe(
      'delivery-remain',
    )
  })

  test('拒绝未知参数、缺项、同时 dry-run+apply、非法 uuid', () => {
    expect(() => parseBackfillCliArgs(['--kind', 'invoice'])).toThrow(/ids-file/)
    expect(() => parseBackfillCliArgs(['--ids-file', idsPath])).toThrow(/--kind/)
    expect(() => parseBackfillCliArgs(['--kind', 'foo', '--ids-file', idsPath])).toThrow(/invoice\|bill/)
    expect(() =>
      parseBackfillCliArgs(['--kind', 'invoice', '--ids-file', idsPath, '--dry-run', '--apply']),
    ).toThrow(/不能同时/)
    expect(() => parseBackfillCliArgs(['--kind', 'invoice', '--ids-file', idsPath, '--foo'])).toThrow(
      /不支持的参数/,
    )
    const bad = join(dir, 'bad.txt')
    writeFileSync(bad, 'not-a-uuid\n')
    expect(() => parseBackfillCliArgs(['--kind', 'invoice', '--ids-file', bad])).toThrow(/非法 UUID/)
  })

  test('空文件得到空列表', () => {
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '\n# only comment\n')
    const args = parseBackfillCliArgs(['--kind', 'delivery-remain', '--ids-file', empty])
    expect(args.ids).toEqual([])
  })
})

describe('backfillEachDoc', () => {
  test('先打当前 id；失败 JSON 带 {id, error, docs}', async () => {
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0] ?? ''))
    }
    try {
      const docs = await backfillEachDoc('invoice', [a, b, a], async (id) => {
        if (id === b) throw new Error('票失败')
      })
      expect(docs).toEqual([
        { id: a, status: 'ok' },
        { id: b, status: 'error', error: '票失败' },
        { id: a, status: 'ok' },
      ])
      expect(logs.some((line) => line.includes(a))).toBe(true)
      expect(logs.some((line) => line.includes('backfill_item_failed'))).toBe(true)
    } finally {
      console.log = orig
    }
  })
})

describe('resolveBackfillDatabaseUrl', () => {
  test('DATABASE_URL 优先；否则拼 PG*', () => {
    expect(resolveBackfillDatabaseUrl({ DATABASE_URL: 'postgres://x' })).toBe('postgres://x')
    expect(
      resolveBackfillDatabaseUrl({
        PGDATABASE: 'synie',
        PGUSER: 'u',
        PGPASSWORD: 'p',
        PGHOST: 'h',
        PGPORT: '5433',
      }),
    ).toBe('postgres://u:p@h:5433/synie?sslmode=disable')
    expect(() => resolveBackfillDatabaseUrl({})).toThrow(/DATABASE_URL/)
  })
})
