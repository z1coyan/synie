import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConverterError, createLibreOfficeConverter } from './converter'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fakeSoffice(body: string): Promise<{ executable: string; tmpRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'synie-worker-test-'))
  roots.push(root)
  const executable = join(root, 'soffice')
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "LibreOffice test"; exit 0; fi\nout=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in --outdir) out="$2"; shift 2;; *) shift;; esac\ndone\n${body}\n`)
  await chmod(executable, 0o755)
  const tmpRoot = join(root, 'tmp')
  await Bun.$`mkdir -p ${tmpRoot}`.quiet()
  return { executable, tmpRoot }
}

describe('LibreOffice converter', () => {
  test('produces one PDF and always removes its task directory', async () => {
    const fixture = await fakeSoffice("printf '%s' '%PDF-1.7 worker' > \"$out/document.pdf\"")
    const converter = createLibreOfficeConverter({ ...fixture, timeoutMs: 2_000 })
    const pdf = await converter.convert(new TextEncoder().encode('xlsx'))
    expect(new TextDecoder().decode(pdf)).toBe('%PDF-1.7 worker')
    expect(await readdir(fixture.tmpRoot)).toEqual([])
  })

  test('maps timeout, nonzero and missing output to stable internal codes', async () => {
    const timeout = await fakeSoffice('sleep 5')
    await expect(createLibreOfficeConverter({ ...timeout, timeoutMs: 100 }).convert(new Uint8Array([1])))
      .rejects.toMatchObject({ code: 'timeout' })
    const failed = await fakeSoffice("echo 'secret https://example.invalid/x /tmp/private' >&2; exit 3")
    try {
      await createLibreOfficeConverter({ ...failed }).convert(new Uint8Array([1]))
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ConverterError)
      expect((error as Error).message).not.toContain('https://')
      expect((error as Error).message).not.toContain('/tmp/private')
    }
    const empty = await fakeSoffice('exit 0')
    await expect(createLibreOfficeConverter({ ...empty }).convert(new Uint8Array([1])))
      .rejects.toMatchObject({ code: 'no_output' })
  })
})
