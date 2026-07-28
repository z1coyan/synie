/**
 * PDF 转换：LibreOffice headless 哑转换。
 * 对齐 server-go platform/printing/pdf.go（独立 profile、timeout 包裹、并发限流）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { which } from 'bun'

export const ERR_SOFFICE_NOT_FOUND = Object.assign(new Error('soffice_not_found'), {
  code: 'soffice_not_found' as const,
})
export const ERR_SOFFICE_TIMEOUT = Object.assign(new Error('timeout'), {
  code: 'timeout' as const,
})
export const ERR_SOFFICE_NO_OUTPUT = Object.assign(new Error('no_output'), {
  code: 'no_output' as const,
})

export class ConvertFailedError extends Error {
  readonly detail: string
  constructor(detail = '') {
    super(detail ? `convert_failed: ${detail}` : 'convert_failed')
    this.name = 'ConvertFailedError'
    this.detail = detail
  }
}

export interface PDFConverter {
  convertXlsxToPdf(xlsx: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CONCURRENCY = 2

export interface SofficeConverterOptions {
  path?: string
  timeoutMs?: number
  maxConcurrency?: number
}

export function createSofficeConverter(options: SofficeConverterOptions = {}): PDFConverter {
  const path = options.path && options.path.length > 0 ? options.path : 'soffice'
  const timeoutMs =
    options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxConcurrency =
    options.maxConcurrency && options.maxConcurrency > 0
      ? options.maxConcurrency
      : DEFAULT_MAX_CONCURRENCY

  const sem = createSemaphore(maxConcurrency)

  async function available(): Promise<boolean> {
    if (!path) return false
    if (path.includes('/') || path.includes('\\')) {
      try {
        const file = Bun.file(path)
        return await file.exists()
      } catch {
        return false
      }
    }
    return (await which(path)) !== null
  }

  async function convertXlsxToPdf(
    xlsx: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!(await available())) throw ERR_SOFFICE_NOT_FOUND
    await sem.acquire(signal)
    try {
      return await doConvert(xlsx, signal)
    } finally {
      sem.release()
    }
  }

  async function doConvert(xlsx: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'synie-print-'))
    try {
      const inDir = join(tmpRoot, 'in')
      const outDir = join(tmpRoot, 'out')
      const profileDir = join(tmpRoot, 'profile')
      await mkdir(inDir, { recursive: true })
      await mkdir(outDir, { recursive: true })
      await mkdir(profileDir, { recursive: true })
      const inPath = join(inDir, 'doc.xlsx')
      await writeFile(inPath, xlsx)

      const args = [
        '--headless',
        '--norestore',
        '--nolockcheck',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inPath,
      ]

      let name = path
      let cmdArgs = args
      let wrapped = false
      const timeoutBin = await which('timeout')
      if (timeoutBin) {
        let secs = Math.ceil(timeoutMs / 1000)
        if (secs < 1) secs = 1
        name = timeoutBin
        cmdArgs = ['-k', '5', String(secs), path, ...args]
        wrapped = true
      }

      let backstop = timeoutMs
      if (wrapped) backstop += 10_000

      const { exitCode, stdout, stderr, timedOut } = await runCommand(
        name,
        cmdArgs,
        backstop,
        signal,
      )
      if (timedOut) throw ERR_SOFFICE_TIMEOUT
      if (exitCode === 0) return await readPdfOutput(outDir)
      if (wrapped && (exitCode === 124 || exitCode === 137 || exitCode === 125)) {
        throw ERR_SOFFICE_TIMEOUT
      }
      const detail = `${stdout}${stderr}`.trim()
      if (detail) {
        const runes = [...detail]
        const clipped = runes.length > 200 ? runes.slice(0, 200).join('') : detail
        throw new ConvertFailedError(`退出码 ${exitCode}: ${clipped}`)
      }
      throw new ConvertFailedError()
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  }

  return { convertXlsxToPdf }
}

function createSemaphore(max: number) {
  let available = max
  const waiters: Array<() => void> = []
  return {
    async acquire(signal?: AbortSignal): Promise<void> {
      if (available > 0) {
        available -= 1
        return
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = waiters.indexOf(resolve)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(signal?.reason ?? new Error('aborted'))
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      available -= 1
    },
    release(): void {
      available += 1
      const next = waiters.shift()
      if (next) next()
    },
  }
}

async function runCommand(
  name: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const child = spawn(name, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already dead */
        }
      }, 1000).unref()
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

async function readPdfOutput(outDir: string): Promise<Uint8Array> {
  const entries = await readdir(outDir)
  const pdfName = entries.find((n) => n.toLowerCase().endsWith('.pdf'))
  if (!pdfName) throw ERR_SOFFICE_NO_OUTPUT
  const data = await readFile(join(outDir, pdfName))
  const text = data.subarray(0, 4).toString('utf8')
  if (text !== '%PDF') throw ERR_SOFFICE_NO_OUTPUT
  return new Uint8Array(data)
}
