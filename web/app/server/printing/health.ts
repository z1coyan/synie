import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLibreOfficeConverter } from './converter'

if (typeof window !== 'undefined') throw new Error('print worker health is server-only')

const exec = promisify(execFile)

export async function printWorkerReadiness(): Promise<Response> {
  let root: string | undefined
  try {
    const converter = createLibreOfficeConverter({ executable: process.env.PRINT_WORKER_SOFFICE_PATH })
    const version = await converter.version()
    root = await mkdtemp(join(tmpdir(), 'synie-print-health-'))
    await writeFile(join(root, 'write-probe'), 'ok')
    const { stdout } = await exec('fc-match', ['Noto Sans CJK SC'], { timeout: 5_000 })
    const font = stdout.trim().split(/\r?\n/)[0] ?? ''
    const ready = Boolean(version && font)
    return Response.json({
      version: 1,
      ready,
      converter: { engine: 'libreoffice', version },
      capabilities: { writableTmp: true, cjkFont: Boolean(font), font },
    }, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } })
  } catch {
    return Response.json({
      version: 1,
      ready: false,
      converter: { engine: 'libreoffice', version: '' },
      capabilities: { writableTmp: false, cjkFont: false, font: '' },
    }, { status: 503, headers: { 'cache-control': 'no-store' } })
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
  }
}
