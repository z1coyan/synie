import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { which } from 'bun'
import {
  ConvertFailedError,
  createSofficeConverter,
  ERR_SOFFICE_NO_OUTPUT,
  ERR_SOFFICE_NOT_FOUND,
  ERR_SOFFICE_TIMEOUT,
} from './pdf.ts'

function fakeSoffice(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-soffice-'))
  const path = join(dir, 'fake-soffice.sh')
  const script =
    '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n' +
    '  case "$1" in --outdir) out="$2"; shift 2;; *) shift;; esac\n' +
    'done\n' +
    body
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

describe('SofficeConverter', () => {
  test('success', async () => {
    const path = fakeSoffice("printf '%s' '%PDF-1.4 fake' > \"$out/doc.pdf\"\nexit 0\n")
    const converter = createSofficeConverter({ path, timeoutMs: 5000, maxConcurrency: 1 })
    const pdf = await converter.convertXlsxToPdf(new TextEncoder().encode('fake-xlsx'))
    expect(new TextDecoder().decode(pdf)).toBe('%PDF-1.4 fake')
  })

  test('not found', async () => {
    const converter = createSofficeConverter({
      path: join(tmpdir(), 'no-such-soffice-xyz'),
      timeoutMs: 1000,
      maxConcurrency: 1,
    })
    await expect(
      converter.convertXlsxToPdf(new TextEncoder().encode('x')),
    ).rejects.toBe(ERR_SOFFICE_NOT_FOUND)
  })

  test('convert failed', async () => {
    const path = fakeSoffice("echo 'broken file' >&2\nexit 3\n")
    const converter = createSofficeConverter({ path, timeoutMs: 5000, maxConcurrency: 1 })
    try {
      await converter.convertXlsxToPdf(new TextEncoder().encode('x'))
      throw new Error('expected failure')
    } catch (err) {
      expect(err).toBeInstanceOf(ConvertFailedError)
      expect((err as ConvertFailedError).detail).not.toBe('')
    }
  })

  test('no output', async () => {
    const path = fakeSoffice('exit 0\n')
    const converter = createSofficeConverter({ path, timeoutMs: 5000, maxConcurrency: 1 })
    await expect(
      converter.convertXlsxToPdf(new TextEncoder().encode('x')),
    ).rejects.toBe(ERR_SOFFICE_NO_OUTPUT)
  })

  test('timeout kills hung process', async () => {
    if (!(await which('timeout'))) return // 无 timeout(1) 时跳过进程组杀除断言
    const dir = mkdtempSync(join(tmpdir(), 'fake-soffice-to-'))
    const pidFile = join(dir, 'pid')
    const path = fakeSoffice(`echo $$ > "${pidFile}"\nsleep 60\n`)
    const converter = createSofficeConverter({ path, timeoutMs: 1000, maxConcurrency: 1 })
    const start = Date.now()
    await expect(
      converter.convertXlsxToPdf(new TextEncoder().encode('x')),
    ).rejects.toBe(ERR_SOFFICE_TIMEOUT)
    expect(Date.now() - start).toBeLessThan(10_000)
    try {
      const raw = readFileSync(pidFile, 'utf8').trim()
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const alive = Bun.spawnSync(['kill', '-0', raw])
        if (alive.exitCode !== 0) return
        await Bun.sleep(100)
      }
      throw new Error('超时后假进程仍存活')
    } catch (err) {
      if (err instanceof Error && err.message.includes('假进程')) throw err
      // pid 文件未写出则跳过杀除断言
    }
  })

  test('concurrency limit serializes conversions', async () => {
    const path = fakeSoffice(
      'sleep 0.3\nprintf \'%s\' \'%PDF\' > "$out/doc.pdf"\n',
    )
    const converter = createSofficeConverter({ path, timeoutMs: 10_000, maxConcurrency: 1 })
    const start = Date.now()
    await Promise.all([
      converter.convertXlsxToPdf(new TextEncoder().encode('x')),
      converter.convertXlsxToPdf(new TextEncoder().encode('y')),
    ])
    expect(Date.now() - start).toBeGreaterThanOrEqual(500)
  })
})
