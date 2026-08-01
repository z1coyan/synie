/** Stable, implementation-neutral v1 contract for the internal PDF converter. */
export const PRINT_WORKER_VERSION = 1 as const
export const PRINT_WORKER_TIMESTAMP_HEADER = 'x-synie-timestamp'
export const PRINT_WORKER_SIGNATURE_HEADER = 'x-synie-signature'
export const PRINT_WORKER_MAX_BODY_BYTES = 64 * 1024
export const PRINT_WORKER_MAX_CLOCK_SKEW_MS = 60_000
export const PRINT_WORKER_PDF_CONTENT_TYPE = 'application/pdf' as const

export const PRINT_WORKER_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'input_mismatch',
  'timeout',
  'convert_failed',
  'output_failed',
  'busy',
] as const

export type PrintWorkerErrorCode = (typeof PRINT_WORKER_ERROR_CODES)[number]

export type ConvertRequestV1 = {
  version: 1
  jobId: string
  attempt: number
  deadlineAt: number
  input: { getUrl: string; size: number; sha256: string }
  output: { putUrl: string; headers: Record<string, string> }
}

export type ConvertResponseV1 = {
  version: 1
  jobId: string
  output: {
    size: number
    sha256: string
    contentType: typeof PRINT_WORKER_PDF_CONTENT_TYPE
  }
  converter: { engine: 'libreoffice'; version: string }
}

export type ConvertErrorV1 = {
  version: 1
  error: { code: PrintWorkerErrorCode; message: string }
}

export class PrintWorkerContractError extends Error {
  readonly code: PrintWorkerErrorCode

  constructor(code: PrintWorkerErrorCode, message: string) {
    super(message)
    this.name = 'PrintWorkerContractError'
    this.code = code
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrintWorkerContractError('bad_request', `${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    throw new PrintWorkerContractError('bad_request', `${label} 包含未知字段`)
  }
  const missing = keys.filter((key) => !(key in value))
  if (missing.length) {
    throw new PrintWorkerContractError('bad_request', `${label} 缺少字段`)
  }
}

function nonEmptyString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new PrintWorkerContractError('bad_request', `${label} 不合法`)
  }
  return value
}

function safePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new PrintWorkerContractError('bad_request', `${label} 不合法`)
  }
  return Number(value)
}

function sha256(value: unknown, label: string): string {
  const text = nonEmptyString(value, label, 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new PrintWorkerContractError('bad_request', `${label} 不合法`)
  }
  return text
}

function headers(value: unknown): Record<string, string> {
  const source = object(value, 'output.headers')
  const result: Record<string, string> = {}
  if (Object.keys(source).length > 16) {
    throw new PrintWorkerContractError('bad_request', 'output.headers 过多')
  }
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.toLowerCase()
    if (!/^[a-z0-9-]{1,64}$/.test(key) || typeof rawValue !== 'string' || rawValue.length > 4096) {
      throw new PrintWorkerContractError('bad_request', 'output.headers 不合法')
    }
    if (key === 'authorization' || key === 'cookie' || key.startsWith('x-synie-')) {
      throw new PrintWorkerContractError('bad_request', 'output.headers 含禁止字段')
    }
    result[key] = rawValue
  }
  return result
}

export function decodeConvertRequestV1(value: unknown): ConvertRequestV1 {
  const root = object(value, 'request')
  exactKeys(root, ['version', 'jobId', 'attempt', 'deadlineAt', 'input', 'output'], 'request')
  if (root.version !== PRINT_WORKER_VERSION) {
    throw new PrintWorkerContractError('bad_request', '不支持的协议版本')
  }
  const input = object(root.input, 'input')
  exactKeys(input, ['getUrl', 'size', 'sha256'], 'input')
  const output = object(root.output, 'output')
  exactKeys(output, ['putUrl', 'headers'], 'output')
  const jobId = nonEmptyString(root.jobId, 'jobId', 128)
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new PrintWorkerContractError('bad_request', 'jobId 不合法')
  }
  return {
    version: 1,
    jobId,
    attempt: safePositiveInteger(root.attempt, 'attempt'),
    deadlineAt: safePositiveInteger(root.deadlineAt, 'deadlineAt'),
    input: {
      getUrl: nonEmptyString(input.getUrl, 'input.getUrl', 16_384),
      size: safePositiveInteger(input.size, 'input.size'),
      sha256: sha256(input.sha256, 'input.sha256'),
    },
    output: {
      putUrl: nonEmptyString(output.putUrl, 'output.putUrl', 16_384),
      headers: headers(output.headers),
    },
  }
}

export function decodeConvertResponseV1(value: unknown): ConvertResponseV1 {
  const root = object(value, 'response')
  exactKeys(root, ['version', 'jobId', 'output', 'converter'], 'response')
  if (root.version !== 1) throw new PrintWorkerContractError('bad_request', '不支持的协议版本')
  const output = object(root.output, 'output')
  exactKeys(output, ['size', 'sha256', 'contentType'], 'output')
  const converter = object(root.converter, 'converter')
  exactKeys(converter, ['engine', 'version'], 'converter')
  if (output.contentType !== PRINT_WORKER_PDF_CONTENT_TYPE || converter.engine !== 'libreoffice') {
    throw new PrintWorkerContractError('bad_request', '响应能力不匹配')
  }
  return {
    version: 1,
    jobId: nonEmptyString(root.jobId, 'jobId', 128),
    output: {
      size: safePositiveInteger(output.size, 'output.size'),
      sha256: sha256(output.sha256, 'output.sha256'),
      contentType: PRINT_WORKER_PDF_CONTENT_TYPE,
    },
    converter: {
      engine: 'libreoffice',
      version: nonEmptyString(converter.version, 'converter.version', 200),
    },
  }
}

export function printWorkerSignaturePayload(timestamp: string, bodySha256: string): string {
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(bodySha256)) {
    throw new PrintWorkerContractError('bad_request', '签名输入不合法')
  }
  return `${timestamp}\n${bodySha256}`
}

export function printWorkerError(code: PrintWorkerErrorCode, message: string): ConvertErrorV1 {
  return { version: 1, error: { code, message } }
}
