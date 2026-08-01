import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (typeof window !== 'undefined') throw new Error('LibreOffice converter is server-only')

export type ConverterErrorCode = 'not_found' | 'timeout' | 'convert_failed' | 'no_output'

export class ConverterError extends Error {
  readonly code: ConverterErrorCode

  constructor(code: ConverterErrorCode, message: string = code) {
    super(message)
    this.name = 'ConverterError'
    this.code = code
  }
}

export interface PdfConverter {
  convert(xlsx: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
  version(): Promise<string>
}

export interface ConverterOptions {
  executable?: string
  timeoutMs?: number
  tmpRoot?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

function clippedDiagnostic(value: string): string {
  return [...value.replace(/https?:\/\/\S+/g, '[URL]').replace(/\/tmp\/\S+/g, '[PATH]')]
    .slice(0, 200)
    .join('')
}

async function executableAvailable(executable: string): Promise<boolean> {
  if (executable.includes('/') || executable.includes('\\')) {
    return access(executable, constants.X_OK).then(() => true, () => false)
  }
  const path = process.env.PATH?.split(':') ?? []
  for (const directory of path) {
    if (await access(join(directory, executable), constants.X_OK).then(() => true, () => false)) return true
  }
  return false
}

export function createLibreOfficeConverter(options: ConverterOptions = {}): PdfConverter {
  const executable = options.executable?.trim() || 'soffice'
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const tempBase = options.tmpRoot?.trim() || tmpdir()

  async function version(): Promise<string> {
    if (!await executableAvailable(executable)) throw new ConverterError('not_found')
    const result = await run(executable, ['--version'], Math.min(timeoutMs, 10_000))
    if (result.timedOut || result.exitCode !== 0) throw new ConverterError('not_found')
    return clippedDiagnostic(result.stdout.trim() || result.stderr.trim()) || 'unknown'
  }

  async function convert(xlsx: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (!await executableAvailable(executable)) throw new ConverterError('not_found')
    const root = await mkdtemp(join(tempBase, 'synie-print-'))
    try {
      const inputDirectory = join(root, 'input')
      const outputDirectory = join(root, 'output')
      const profileDirectory = join(root, 'profile')
      await Promise.all([
        mkdir(inputDirectory, { recursive: true }),
        mkdir(outputDirectory, { recursive: true }),
        mkdir(profileDirectory, { recursive: true }),
      ])
      const inputPath = join(inputDirectory, 'document.xlsx')
      await writeFile(inputPath, xlsx)
      const result = await run(executable, [
        '--headless',
        '--norestore',
        '--nolockcheck',
        `-env:UserInstallation=file://${profileDirectory}`,
        '--convert-to', 'pdf',
        '--outdir', outputDirectory,
        inputPath,
      ], timeoutMs, signal)
      if (result.timedOut) throw new ConverterError('timeout')
      if (result.exitCode !== 0) {
        throw new ConverterError(
          'convert_failed',
          clippedDiagnostic(`${result.stdout}\n${result.stderr}`.trim()) || 'LibreOffice 转换失败',
        )
      }
      const names = (await readdir(outputDirectory)).filter((name) => name.toLowerCase().endsWith('.pdf'))
      if (names.length !== 1) throw new ConverterError('no_output')
      const pdf = new Uint8Array(await readFile(join(outputDirectory, names[0]!)))
      if (pdf.byteLength < 5 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') {
        throw new ConverterError('no_output')
      }
      return pdf
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  return { convert, version }
}

async function run(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const terminate = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch { /* already exited */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { /* already exited */ }
      }, 1_000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onAbort = () => terminate()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut })
    })
  })
}
