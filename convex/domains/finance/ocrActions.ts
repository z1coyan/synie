"use node"

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mapAcceptanceOcr, mapInvoiceOcr } from '@synie/shared'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action } from '../../_generated/server'
import { readProductObject } from '../../files/s3'
import { synieError } from '../../lib/errors'

const HOST = 'ocr-api.cn-hangzhou.aliyuncs.com'
const VERSION = '2021-07-07'
const MAX_BYTES = 10 * 1024 * 1024
const INVOICE_TYPES = new Set([
  'image/png', 'image/jpg', 'image/jpeg', 'image/bmp', 'image/gif',
  'image/tiff', 'image/webp', 'application/pdf',
])
const ACCEPTANCE_TYPES = new Set([
  'image/png', 'image/jpg', 'image/jpeg', 'image/bmp', 'image/gif',
  'image/tiff', 'image/webp',
])

type FileDescriptor = { objectKey: string; contentType: string | null; size: number }
const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>('files/domain:currentUserForAction')
const authorizeRef = makeFunctionReference<'query', {
  userId: string; command: 'invoice' | 'acceptance' | 'configured'
}, null>('domains/finance/ocr:authorize')
const fileRef = makeFunctionReference<'query', {
  fileId: string; userId: string
}, FileDescriptor>('files/domain:authorizeDownload')

function credentials(): { accessKeyId: string; accessKeySecret: string } {
  const accessKeyId = process.env.SYNIE_OCR_ACCESS_KEY_ID?.trim() ?? ''
  const accessKeySecret = process.env.SYNIE_OCR_ACCESS_KEY_SECRET?.trim() ?? ''
  if (!accessKeyId || !accessKeySecret) {
    throw synieError('validation', 'OCR 未配置，请联系管理员')
  }
  return { accessKeyId, accessKeySecret }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function callProvider(actionName: string, body: Uint8Array): Promise<Record<string, unknown>> {
  const { accessKeyId, accessKeySecret } = credentials()
  const payloadHash = sha256(body)
  const headers: Array<[string, string]> = [
    ['content-type', 'application/octet-stream'],
    ['host', HOST],
    ['x-acs-action', actionName],
    ['x-acs-content-sha256', payloadHash],
    ['x-acs-date', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')],
    ['x-acs-signature-nonce', randomBytes(16).toString('hex')],
    ['x-acs-version', VERSION],
  ]
  const signed = headers.map(([name]) => name).join(';')
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join('')
  const canonical = ['POST', '/', '', canonicalHeaders, signed, payloadHash].join('\n')
  const signature = createHmac('sha256', accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`).digest('hex')
  const authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signed},Signature=${signature}`
  let response: Response
  try {
    response = await fetch(`https://${HOST}/`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: Object.fromEntries([
        ...headers.filter(([name]) => name !== 'host'),
        ['authorization', authorization],
      ]),
      body: Buffer.from(body),
    })
  } catch {
    throw synieError('validation', 'OCR 服务暂时无法连接，请稍后重试')
  }
  let envelope: Record<string, unknown>
  try {
    envelope = JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8')) as Record<string, unknown>
  } catch {
    throw synieError('validation', 'OCR 服务返回了无法识别的响应')
  }
  if (!response.ok) {
    const code = typeof envelope.Code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(envelope.Code)
      ? envelope.Code
      : String(response.status)
    throw synieError('validation', `OCR 服务调用失败(${code})`)
  }
  const data = envelope.Data
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* mapped to stable error below */ }
  }
  throw synieError('validation', 'OCR 服务响应缺少识别结果')
}

async function recognize(ctx: any, fileId: string, kind: 'invoice' | 'acceptance') {
  const { userId } = await ctx.runQuery(currentUserRef, {})
  await ctx.runQuery(authorizeRef, { userId, command: kind })
  const file = await ctx.runQuery(fileRef, { fileId, userId })
  const contentType = file.contentType?.trim().toLowerCase() ?? ''
  const allowed = kind === 'invoice' ? INVOICE_TYPES : ACCEPTANCE_TYPES
  if (!allowed.has(contentType)) throw synieError('validation', 'OCR 不支持该文件格式')
  if (file.size > MAX_BYTES) throw synieError('validation', 'OCR 文件超过 10MB，请压缩后重试')
  const bytes = await readProductObject(file.objectKey, MAX_BYTES)
  const provider = await callProvider(kind === 'invoice' ? 'RecognizeInvoice' : 'RecognizeBankAcceptance', bytes)
  return kind === 'invoice' ? mapInvoiceOcr(provider) : mapAcceptanceOcr(provider)
}

export const configured = action({
  args: {}, returns: v.object({ configured: v.boolean() }),
  handler: async (ctx) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    await ctx.runQuery(authorizeRef, { userId, command: 'configured' })
    return {
      configured: Boolean(
        process.env.SYNIE_OCR_ACCESS_KEY_ID?.trim() &&
        process.env.SYNIE_OCR_ACCESS_KEY_SECRET?.trim(),
      ),
    }
  },
})

export const recognizeVatInvoice = action({
  args: { fileId: v.id('files') }, returns: v.any(),
  handler: (ctx, args) => recognize(ctx, String(args.fileId), 'invoice'),
})

export const recognizeBankAcceptance = action({
  args: { fileId: v.id('files') }, returns: v.any(),
  handler: (ctx, args) => recognize(ctx, String(args.fileId), 'acceptance'),
})
