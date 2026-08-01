import {
  PRINT_WORKER_MAX_BODY_BYTES,
  decodeConvertRequestV1,
  printWorkerError,
  type ConvertRequestV1,
  type ConvertResponseV1,
  type PrintWorkerErrorCode,
} from '@synie/shared'
import { authenticatePrintWorkerRequest, sha256Hex } from './auth'
import { ConverterError, createLibreOfficeConverter, type PdfConverter } from './converter'
import { assertPrintObjectUrl } from './url-policy'

if (typeof window !== 'undefined') throw new Error('print worker service is server-only')

const MAX_INPUT_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024

export interface WorkerDependencies {
  converter?: PdfConverter
  fetch?: typeof fetch
  now?: () => number
  authenticate?: (headers: Headers, body: Uint8Array) => boolean
  assertUrl?: (url: string) => Promise<URL>
  maxConcurrency?: number
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function failure(code: PrintWorkerErrorCode, status: number, message: string): Response {
  return json(printWorkerError(code, message), status)
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > PRINT_WORKER_MAX_BODY_BYTES) throw new Error('body_too_large')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > PRINT_WORKER_MAX_BODY_BYTES) throw new Error('body_too_large')
  return bytes
}

async function boundedDownload(response: Response, expected: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('download_failed')
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) !== expected) throw new Error('input_size_mismatch')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > expected || size > MAX_INPUT_BYTES) {
      await reader.cancel()
      throw new Error('input_size_mismatch')
    }
    chunks.push(result.value)
  }
  if (size !== expected) throw new Error('input_size_mismatch')
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function errorResponse(error: unknown): Response {
  if (error instanceof ConverterError) {
    if (error.code === 'timeout') return failure('timeout', 504, 'PDF 转换超时')
    return failure('convert_failed', 422, 'PDF 转换失败')
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return failure('timeout', 504, 'PDF 转换超时')
  }
  const message = error instanceof Error ? error.message : ''
  if (message.includes('URL') || message.includes('size') || message.includes('checksum') || message === 'download_failed') {
    return failure('input_mismatch', 422, '输入对象校验失败')
  }
  return failure('convert_failed', 500, 'PDF 转换失败')
}

export function createPrintWorkerHandler(dependencies: WorkerDependencies = {}) {
  const converter = dependencies.converter ?? createLibreOfficeConverter({
    executable: process.env.PRINT_WORKER_SOFFICE_PATH,
    timeoutMs: Number(process.env.PRINT_WORKER_TIMEOUT_MS ?? 120_000),
  })
  const requestFetch = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  const authenticate = dependencies.authenticate ?? ((headers, body) => authenticatePrintWorkerRequest(headers, body))
  const assertUrl = dependencies.assertUrl ?? assertPrintObjectUrl
  const capacity = Math.max(1, Math.min(dependencies.maxConcurrency ?? Number(process.env.PRINT_WORKER_CONCURRENCY ?? 2), 16))
  let running = 0

  return async function handle(request: Request, pathJobId: string): Promise<Response> {
    let rawBody: Uint8Array
    try { rawBody = await boundedBody(request) } catch { return failure('bad_request', 400, '请求不合法') }
    if (!authenticate(request.headers, rawBody)) return failure('unauthorized', 401, '认证失败')
    let input: ConvertRequestV1
    try { input = decodeConvertRequestV1(JSON.parse(new TextDecoder().decode(rawBody))) } catch {
      return failure('bad_request', 400, '请求不合法')
    }
    if (input.jobId !== pathJobId) return failure('bad_request', 400, 'jobId 不匹配')
    if (input.deadlineAt <= now()) return failure('timeout', 504, '任务已超时')
    if (input.input.size > MAX_INPUT_BYTES) return failure('input_mismatch', 422, '输入对象过大')
    if (running >= capacity) return failure('busy', 503, '转换器繁忙')
    running += 1
    const startedAt = now()
    try {
      const [getUrl, putUrl] = await Promise.all([
        assertUrl(input.input.getUrl),
        assertUrl(input.output.putUrl),
      ])
      const timeoutMs = Math.max(1, input.deadlineAt - now())
      const signal = AbortSignal.timeout(timeoutMs)
      const xlsx = await boundedDownload(await requestFetch(getUrl, {
        method: 'GET', redirect: 'error', signal,
      }), input.input.size)
      if (sha256Hex(xlsx) !== input.input.sha256) throw new Error('input_checksum_mismatch')
      const pdf = await converter.convert(xlsx, signal)
      if (pdf.byteLength > MAX_OUTPUT_BYTES || pdf.byteLength < 5 ||
          new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') {
        throw new ConverterError('no_output')
      }
      const outputSha256 = sha256Hex(pdf)
      const putHeaders = new Headers(input.output.headers)
      putHeaders.set('content-type', 'application/pdf')
      // S3 validates this digest while accepting the PUT. Do not add dynamic
      // metadata here: S3 requires x-amz-meta-* to be bound into the original
      // presign, while checksum headers are explicitly supported on a
      // presigned UNSIGNED-PAYLOAD request.
      putHeaders.set(
        'x-amz-checksum-sha256',
        Buffer.from(outputSha256, 'hex').toString('base64'),
      )
      const uploaded = await requestFetch(putUrl, {
        method: 'PUT', headers: putHeaders, body: new Uint8Array(pdf).buffer, redirect: 'error', signal,
      })
      if (!uploaded.ok) return failure('output_failed', 502, '输出对象写入失败')
      const response: ConvertResponseV1 = {
        version: 1,
        jobId: input.jobId,
        output: { size: pdf.byteLength, sha256: outputSha256, contentType: 'application/pdf' },
        converter: { engine: 'libreoffice', version: await converter.version() },
      }
      console.info(JSON.stringify({ event: 'print_worker_complete', jobId: input.jobId, attempt: input.attempt, durationMs: now() - startedAt, inputBytes: xlsx.byteLength, outputBytes: pdf.byteLength }))
      return json(response)
    } catch (error) {
      console.error(JSON.stringify({ event: 'print_worker_failed', jobId: input.jobId, attempt: input.attempt, durationMs: now() - startedAt, code: error instanceof ConverterError ? error.code : 'worker_error' }))
      return errorResponse(error)
    } finally {
      running -= 1
    }
  }
}

export const handlePrintWorkerExecute = createPrintWorkerHandler()
