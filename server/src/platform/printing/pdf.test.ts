import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConvertFailedError,
  createSofficeConverter,
  ERR_SOFFICE_NO_OUTPUT,
  ERR_SOFFICE_NOT_FOUND,
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
})
