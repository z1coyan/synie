/**
 * 阿里云 OCR：读 acc_setting 凭证，RecognizeInvoice → 发票草稿预填。
 * 行为对齐 server-go documents/ocr.go（发票路径）。
 */
import { createHmac, createHash, randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { StoredFile } from '~/platform/files/types.ts'

const ALIYUN_OCR_HOST = 'ocr-api.cn-hangzhou.aliyuncs.com'
const ALIYUN_OCR_VERSION = '2021-07-07'
const MAX_OCR_SIZE = 10 * 1024 * 1024

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpg',
  'image/jpeg',
  'image/bmp',
  'image/gif',
  'image/tiff',
  'image/webp',
  'application/pdf',
])

const nonAmountCharacters = /[^0-9.\-]/g
const dateNumbers = /\d+/g

export type OcrPrefill = Record<string, unknown>

export interface OcrDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
  nonce?: () => string
}

export async function recognizeVatInvoice(
  db: DbHandle,
  file: StoredFile,
  content: Uint8Array,
  deps: OcrDeps = {},
): Promise<OcrPrefill> {
  const contentType = (file.contentType ?? '').trim().toLowerCase()
  if (!IMAGE_TYPES.has(contentType)) {
    throw ApiError.validation('OCR 文件不合法', { fileId: ['不支持的文件格式'] })
  }
  if (file.size > MAX_OCR_SIZE || content.byteLength > MAX_OCR_SIZE) {
    throw ApiError.validation('OCR 文件不合法', {
      fileId: ['文件超过 10MB,请压缩后重试'],
    })
  }

  const creds = await sql<{
    ocr_access_key_id: string | null
    ocr_access_key_secret: string | null
  }>`
    SELECT ocr_access_key_id, ocr_access_key_secret
    FROM acc_setting ORDER BY inserted_at LIMIT 1
  `.execute(db)
  const row = creds.rows[0]
  const accessKeyId = (row?.ocr_access_key_id ?? '').trim()
  const accessKeySecret = (row?.ocr_access_key_secret ?? '').trim()
  if (!accessKeyId || !accessKeySecret) {
    throw ApiError.validation('OCR 未配置', {
      fileId: ['未配置阿里云 OCR 凭证'],
    })
  }

  const data = await callAliyun(
    'RecognizeInvoice',
    content,
    accessKeyId,
    accessKeySecret,
    deps,
  )
  return mapInvoiceOCR(data)
}

async function callAliyun(
  action: string,
  body: Uint8Array,
  accessKeyId: string,
  accessKeySecret: string,
  deps: OcrDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? (() => new Date())
  const nonce =
    deps.nonce ??
    (() => randomBytes(16).toString('hex'))
  const fetchImpl = deps.fetchImpl ?? fetch

  const payloadHash = sha256Hex(body)
  const headers: Array<[string, string]> = [
    ['content-type', 'application/octet-stream'],
    ['host', ALIYUN_OCR_HOST],
    ['x-acs-action', action],
    ['x-acs-content-sha256', payloadHash],
    ['x-acs-date', now().toISOString().replace(/\.\d{3}Z$/, 'Z')],
    ['x-acs-signature-nonce', nonce()],
    ['x-acs-version', ALIYUN_OCR_VERSION],
  ]
  const signedNames = headers.map(([k]) => k)
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join('')
  const signed = signedNames.join(';')
  const canonical = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signed,
    payloadHash,
  ].join('\n')
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(new TextEncoder().encode(canonical))}`
  const signature = createHmac('sha256', accessKeySecret)
    .update(stringToSign)
    .digest('hex')
  const authorization =
    `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signed},Signature=${signature}`

  let response: Response
  try {
    response = await fetchImpl(`https://${ALIYUN_OCR_HOST}/`, {
      method: 'POST',
      headers: Object.fromEntries([
        ...headers.filter(([k]) => k !== 'host'),
        ['authorization', authorization],
      ]),
      body: Buffer.from(body),
    })
  } catch (err) {
    throw ApiError.validation('阿里云 OCR 网络错误', {
      fileId: [err instanceof Error ? err.message : String(err)],
    })
  }

  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw ApiError.validation('阿里云 OCR 响应不合法', {
      fileId: ['无法解析响应'],
    })
  }
  if (!response.ok) {
    const code = typeof envelope.Code === 'string' ? envelope.Code : ''
    const message = typeof envelope.Message === 'string' ? envelope.Message : ''
    throw ApiError.validation('阿里云 OCR 调用失败', {
      fileId: [`${code}:${message}`.trim()],
    })
  }
  const data = envelope.Data
  if (data === undefined) {
    throw ApiError.validation('阿里云 OCR 响应不合法', {
      fileId: ['返回缺少 Data 字段'],
    })
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Record<string, unknown>
    } catch {
      // fallthrough
    }
  }
  throw ApiError.validation('阿里云 OCR 响应不合法', {
    fileId: ['Data 无法解析'],
  })
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nestedOCRData(input: Record<string, unknown>): Record<string, unknown> {
  const inner = input.data
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return input
}

function mapInvoiceOCR(input: Record<string, unknown>): OcrPrefill {
  const data = nestedOCRData(input)
  const result: OcrPrefill = {}
  putText(result, 'invoiceCode', data.invoiceCode)
  putText(result, 'invoiceNo', data.invoiceNumber)
  putDate(result, 'invoiceDate', data.invoiceDate)
  const kind = invoiceKind(textOCR(data.invoiceType))
  if (kind) result.invoiceKind = kind
  putText(result, 'sellerName', data.sellerName)
  putText(result, 'sellerTaxNo', data.sellerTaxNumber)
  putText(result, 'sellerAddressPhone', data.sellerContactInfo)
  putText(result, 'sellerBankAccount', data.sellerBankAccountInfo)
  putText(result, 'buyerName', data.purchaserName)
  putText(result, 'buyerTaxNo', data.purchaserTaxNumber)
  putText(result, 'buyerAddressPhone', data.purchaserContactInfo)
  putText(result, 'buyerBankAccount', data.purchaserBankAccountInfo)
  putAmount(result, 'netTotal', data.invoiceAmountPreTax)
  putAmount(result, 'taxTotal', data.invoiceTax)
  putAmount(result, 'grossTotal', data.totalAmount)
  putText(result, 'issuer', data.drawer)
  putText(result, 'reviewer', data.reviewer)
  putText(result, 'payee', data.recipient)
  putText(result, 'remarks', data.remarks)
  if (Array.isArray(data.invoiceDetails) && data.invoiceDetails.length > 0) {
    const items: Record<string, unknown>[] = []
    for (const raw of data.invoiceDetails) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const item: Record<string, unknown> = {}
      putText(item, 'name', row.itemName)
      putText(item, 'model', row.specification)
      putText(item, 'unit', row.unit)
      putAmount(item, 'quantity', row.quantity)
      putAmount(item, 'price', row.unitPrice)
      putAmount(item, 'net_amount', row.amount)
      putText(item, 'tax_rate', row.taxRate)
      putAmount(item, 'tax_amount', row.tax)
      items.push(item)
    }
    if (items.length > 0) result.items = items
  }
  return result
}

function textOCR(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function amountOCR(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value.replace(nonAmountCharacters, '')
  return ''
}

function dateOCR(value: unknown): string {
  const parts = textOCR(value).match(dateNumbers) ?? []
  let year = ''
  let month = ''
  let day = ''
  if (parts.length >= 3 && parts[0]!.length === 4) {
    ;[year, month, day] = [parts[0]!, parts[1]!, parts[2]!]
  } else if (parts.length === 1 && parts[0]!.length === 8) {
    year = parts[0]!.slice(0, 4)
    month = parts[0]!.slice(4, 6)
    day = parts[0]!.slice(6, 8)
  } else {
    return ''
  }
  const padded = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const d = new Date(`${padded}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  return padded
}

function invoiceKind(value: string): string {
  if (!value) return ''
  const special = value.includes('专用')
  if (value.includes('数电') && special) return 'DIGITAL_SPECIAL'
  if (value.includes('数电')) return 'DIGITAL_NORMAL'
  if (value.includes('电子') && special) return 'ELECTRONIC_SPECIAL'
  if (value.includes('电子')) return 'ELECTRONIC_NORMAL'
  if (special) return 'SPECIAL'
  return 'NORMAL'
}

function putText(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = textOCR(value)
  if (parsed) target[key] = parsed
}

function putAmount(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = amountOCR(value)
  if (parsed) target[key] = parsed
}

function putDate(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = dateOCR(value)
  if (parsed) target[key] = parsed
}
