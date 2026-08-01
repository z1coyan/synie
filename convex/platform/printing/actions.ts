"use node"

import { createHash, createHmac } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  PRINT_WORKER_MAX_BODY_BYTES,
  PRINT_WORKER_PDF_CONTENT_TYPE,
  PRINT_WORKER_SIGNATURE_HEADER,
  PRINT_WORKER_TIMESTAMP_HEADER,
  decodeConvertResponseV1,
  printWorkerSignaturePayload,
  type ConvertRequestV1,
  type PrintWorkerErrorCode,
} from '@synie/shared'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action, internalAction } from '../../_generated/server'
import { synieError, validationError } from '../../lib/errors'
import {
  deleteProductObject,
  internalProductS3Client,
  productBucket,
  publicProductS3Client,
  readProductObject,
} from '../../files/s3'
import { renderPages, renderSheets } from './renderer'
import { PDF_CONTENT_TYPE, XLSX_CONTENT_TYPE } from './types'
import { extractPlaceholders } from './xlsx'
import { validatePlaceholders } from './catalog'

const printResource = v.union(v.literal('sales.order'), v.literal('mfg.work_order'))
const MAX_RENDERED_BYTES = 50 * 1024 * 1024
const ARTIFACT_TTL_MS = 23 * 60 * 60_000

type Prepared = {
  actorUserId: string; companyIds: string[]; filename: string
  template: { objectKey: string; size: number; sha256: string }
  docs: Array<{ sheetName: string; doc: { fields: Record<string, string>; loops: Record<string, Array<Record<string, string>>> } }>
}
type PrepareRenderArgs = {
  resource: 'sales.order' | 'mfg.work_order'
  mode: 'print' | 'export'
  templateId: string
  ids: string[]
}
type Artifact = {
  _id: string; objectKey: string; filename: string; contentType: string; size: number; sha256: string; expiresAt: number
}
type Claimed = {
  jobId: string; attempt: number; deadlineAt: number; leaseToken: string
  input: { objectKey: string; size: number; sha256: string }
  outputObjectKey: string; filename: string; expiresAt: number
}
type JobSummary = {
  id: string; resource: string; templateId: string; status: string; attempts: number
  errorCode: string | null; filename: string; hasOutput: boolean
  insertedAt: string; updatedAt: string; expiresAt: number
}

const prepareCreateRef = makeFunctionReference<'query', any, any>('platform/printing/templates:prepareCreate')
const prepareUpdateRef = makeFunctionReference<'query', any, any>('platform/printing/templates:prepareUpdate')
const commitCreateRef = makeFunctionReference<'mutation', any, any>('platform/printing/templates:commitCreate')
const commitUpdateRef = makeFunctionReference<'mutation', any, any>('platform/printing/templates:commitUpdate')
const prepareRenderRef = makeFunctionReference<'query', PrepareRenderArgs, Prepared>('platform/printing/templates:prepareRender')
const createExportRef = makeFunctionReference<'mutation', any, { artifact: Artifact; reused: boolean }>('platform/printing/jobs:createExportArtifact')
const createJobRef = makeFunctionReference<'mutation', any, { job: JobSummary; reused: boolean }>('platform/printing/jobs:createPrintJob')
const artifactRef = makeFunctionReference<'query', { id: string }, Artifact>('platform/printing/jobs:authorizeArtifact')
const outputRef = makeFunctionReference<'query', { id: string }, Artifact>('platform/printing/jobs:authorizeJobOutput')
const claimRef = makeFunctionReference<'mutation', { jobId: string; leaseToken: string; now: number }, Claimed | null>('platform/printing/jobs:claim')
const completeRef = makeFunctionReference<'mutation', any, null>('platform/printing/jobs:complete')
const failRef = makeFunctionReference<'mutation', any, null>('platform/printing/jobs:fail')
const expiredRef = makeFunctionReference<'query', { now: number; limit?: number }, Array<{ _id: string; objectKey: string }>>('platform/printing/jobs:expiredArtifacts')
const purgeArtifactRef = makeFunctionReference<'mutation', { id: string }, null>('platform/printing/jobs:purgeArtifact')
const purgeJobsRef = makeFunctionReference<'mutation', { now: number; limit?: number }, number>('platform/printing/jobs:purgeJobs')

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function checksumBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

function tempKey(extension: 'xlsx' | 'pdf'): string {
  const date = new Date().toISOString().slice(0, 10)
  return `print-tmp/${date}/${crypto.randomUUID()}.${extension}`
}

function requestKey(parts: unknown[]): string {
  return sha256(JSON.stringify(parts))
}

function permission(resource: string, mode: 'print' | 'export', count: number): string {
  return `${resource}:${mode === 'export' ? 'export' : count > 1 ? 'batch_print' : 'print'}`
}

async function verifiedTemplate(prepared: Prepared): Promise<Uint8Array> {
  const bytes = await readProductObject(prepared.template.objectKey, MAX_RENDERED_BYTES)
  if (bytes.byteLength !== prepared.template.size || sha256(bytes) !== prepared.template.sha256) {
    throw validationError('无法读取模板文件', { templateId: ['模板文件校验失败'] })
  }
  return bytes
}

async function uploadTemp(objectKey: string, bytes: Uint8Array, contentType: string): Promise<{ size: number; sha256: string }> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RENDERED_BYTES) throw validationError('生成文件超过处理上限', { templateId: ['生成文件超过处理上限'] })
  const digest = sha256(bytes)
  const client = internalProductS3Client()
  try {
    await client.send(new PutObjectCommand({
      Bucket: productBucket(), Key: objectKey, Body: bytes, ContentLength: bytes.byteLength,
      ContentType: contentType, ChecksumSHA256: checksumBase64(digest), Metadata: { sha256: digest },
    }))
  } finally { client.destroy() }
  return { size: bytes.byteLength, sha256: digest }
}

function renderPrepared(prepared: Prepared, mode: 'print' | 'export', template: Uint8Array): Uint8Array {
  try {
    return mode === 'export'
      ? renderSheets(template, prepared.docs.map((doc) => ({ name: doc.sheetName, doc: doc.doc })))
      : renderPages(template, prepared.docs.map((doc) => doc.doc))
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析模板'
    throw validationError(message, { templateId: [message] })
  }
}

async function signedDownload(
  artifact: Artifact,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<{ url: string; expiresAt: number; filename: string; contentType: string }> {
  const client = publicProductS3Client()
  try {
    const url = await getSignedUrl(client, new GetObjectCommand({
      Bucket: productBucket(), Key: artifact.objectKey,
      ResponseContentType: artifact.contentType,
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    }), { expiresIn: 300 })
    return { url, expiresAt: Date.now() + 300_000, filename: artifact.filename, contentType: artifact.contentType }
  } finally { client.destroy() }
}

async function validateTemplateFile(prepared: { resource: string; file: { objectKey: string; filename: string; size: number; sha256: string } }): Promise<void> {
  if (!prepared.file.filename.toLowerCase().endsWith('.xlsx')) {
    throw validationError('只接受 .xlsx 模板文件', { fileId: ['只接受 .xlsx 模板文件'] })
  }
  const bytes = await readProductObject(prepared.file.objectKey, MAX_RENDERED_BYTES)
  if (bytes.byteLength !== prepared.file.size || sha256(bytes) !== prepared.file.sha256) {
    throw validationError('无法读取模板文件', { fileId: ['模板文件校验失败'] })
  }
  try { validatePlaceholders(prepared.resource, extractPlaceholders(bytes)) }
  catch (error) {
    const message = error instanceof Error ? error.message : '无法解析模板'
    throw validationError(message, { fileId: [message] })
  }
}

export const createTemplate = action({
  args: { name: v.string(), resource: printResource, fileId: v.id('files'), remarks: v.optional(v.union(v.string(), v.null())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runQuery(prepareCreateRef, args)
    await validateTemplateFile(prepared)
    return ctx.runMutation(commitCreateRef, {
      actorUserId: prepared.actorUserId, name: prepared.name, resource: prepared.resource,
      fileId: prepared.fileId, remarks: prepared.remarks,
    })
  },
})

export const updateTemplate = action({
  args: {
    id: v.id('printTemplates'), name: v.optional(v.string()), fileId: v.optional(v.id('files')),
    remarks: v.optional(v.union(v.string(), v.null())), remarksPresent: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const prepared = await ctx.runQuery(prepareUpdateRef, args)
    await validateTemplateFile(prepared)
    return ctx.runMutation(commitUpdateRef, {
      actorUserId: prepared.actorUserId, id: prepared.id, name: prepared.name,
      fileId: prepared.fileId, remarks: prepared.remarks,
    })
  },
})

export const exportXlsx = action({
  args: { resource: printResource, templateId: v.id('printTemplates'), ids: v.array(v.string()), requestNonce: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!args.requestNonce.trim() || args.requestNonce.length > 128) throw synieError('validation', 'requestNonce 不合法')
    const prepared = await ctx.runQuery(prepareRenderRef, {
      resource: args.resource,
      mode: 'export',
      templateId: args.templateId,
      ids: args.ids,
    })
    const bytes = renderPrepared(prepared, 'export', await verifiedTemplate(prepared))
    const objectKey = tempKey('xlsx')
    const uploaded = await uploadTemp(objectKey, bytes, XLSX_CONTENT_TYPE)
    const expiresAt = Date.now() + ARTIFACT_TTL_MS
    const key = requestKey([prepared.actorUserId, args.resource, args.templateId, args.ids, args.requestNonce, 'export'])
    try {
      const created = await ctx.runMutation(createExportRef, {
        actorUserId: prepared.actorUserId, companyIds: prepared.companyIds, resource: args.resource,
        permission: permission(args.resource, 'export', args.ids.length), requestKey: key,
        objectKey, filename: prepared.filename, contentType: XLSX_CONTENT_TYPE,
        ...uploaded, expiresAt,
      })
      if (created.reused) await deleteProductObject(objectKey)
      return { artifactId: created.artifact._id, ...(await signedDownload(created.artifact)) }
    } catch (error) {
      await deleteProductObject(objectKey).catch(() => undefined)
      throw error
    }
  },
})

export const startPrint = action({
  args: { resource: printResource, templateId: v.id('printTemplates'), ids: v.array(v.string()), requestNonce: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!args.requestNonce.trim() || args.requestNonce.length > 128) throw synieError('validation', 'requestNonce 不合法')
    const prepared = await ctx.runQuery(prepareRenderRef, {
      resource: args.resource,
      mode: 'print',
      templateId: args.templateId,
      ids: args.ids,
    })
    const bytes = renderPrepared(prepared, 'print', await verifiedTemplate(prepared))
    const inputObjectKey = tempKey('xlsx')
    const uploaded = await uploadTemp(inputObjectKey, bytes, XLSX_CONTENT_TYPE)
    const expiresAt = Date.now() + ARTIFACT_TTL_MS
    const key = requestKey([prepared.actorUserId, args.resource, args.templateId, args.ids, args.requestNonce, 'print'])
    const outputObjectKey = tempKey('pdf')
    try {
      const created = await ctx.runMutation(createJobRef, {
        actorUserId: prepared.actorUserId, companyIds: prepared.companyIds, resource: args.resource,
        permission: permission(args.resource, 'print', args.ids.length), templateId: args.templateId,
        idempotencyKey: key,
        input: { objectKey: inputObjectKey, filename: `${key}.xlsx`, contentType: XLSX_CONTENT_TYPE, ...uploaded },
        outputObjectKey, filename: prepared.filename, expiresAt,
      })
      if (created.reused) await deleteProductObject(inputObjectKey)
      return created.job
    } catch (error) {
      await deleteProductObject(inputObjectKey).catch(() => undefined)
      throw error
    }
  },
})

export const downloadArtifact = action({
  args: { id: v.id('printArtifacts') }, returns: v.any(),
  handler: async (ctx, args) => signedDownload(await ctx.runQuery(artifactRef, args)),
})

export const printResultUrl = action({
  args: { jobId: v.id('printJobs') }, returns: v.any(),
  handler: async (ctx, args) => signedDownload(
    await ctx.runQuery(outputRef, { id: args.jobId }),
    'inline',
  ),
})

function workerEndpoint(jobId: string): string {
  const configured = process.env.PRINT_WORKER_URL?.trim()
  if (!configured) throw Object.assign(new Error('worker_unconfigured'), { stableCode: 'worker_unavailable', retryable: true })
  const base = configured.replace(/\/+$/, '')
  return base.includes('/api/internal/print-worker/v1/jobs/')
    ? base.replace(':jobId', encodeURIComponent(jobId))
    : `${base}/api/internal/print-worker/v1/jobs/${encodeURIComponent(jobId)}/execute`
}

function workerSecret(): string {
  const secret = process.env.PRINT_WORKER_HMAC_SECRET ?? ''
  if (Buffer.byteLength(secret) < 32) throw Object.assign(new Error('worker_unconfigured'), { stableCode: 'worker_unavailable', retryable: true })
  return secret
}

function workerFailure(error: unknown): { code: string; retryable: boolean } {
  if (error && typeof error === 'object' && 'stableCode' in error) {
    return { code: String((error as any).stableCode), retryable: Boolean((error as any).retryable) }
  }
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { code: 'timeout', retryable: true }
  return { code: 'worker_unavailable', retryable: true }
}

export const dispatch = internalAction({
  args: { jobId: v.id('printJobs') }, returns: undefined,
  handler: async (ctx, args) => {
    const startedAt = Date.now()
    const leaseToken = crypto.randomUUID()
    const claimed = await ctx.runMutation(claimRef, { jobId: args.jobId, leaseToken, now: Date.now() })
    if (!claimed) return
    console.info(JSON.stringify({ event: 'print_dispatch_claimed', jobId: claimed.jobId, attempt: claimed.attempt }))
    try {
      const client = internalProductS3Client()
      let getUrl: string
      let putUrl: string
      try {
        getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: productBucket(), Key: claimed.input.objectKey }), { expiresIn: 180 })
        putUrl = await getSignedUrl(client, new PutObjectCommand({
          Bucket: productBucket(), Key: claimed.outputObjectKey, ContentType: PDF_CONTENT_TYPE,
        }), { expiresIn: 180, signableHeaders: new Set(['content-type']) })
      } finally { client.destroy() }
      const body: ConvertRequestV1 = {
        version: 1, jobId: claimed.jobId, attempt: claimed.attempt, deadlineAt: claimed.deadlineAt,
        input: { getUrl, size: claimed.input.size, sha256: claimed.input.sha256 },
        output: { putUrl, headers: { 'content-type': PDF_CONTENT_TYPE } },
      }
      const raw = JSON.stringify(body)
      if (Buffer.byteLength(raw) > PRINT_WORKER_MAX_BODY_BYTES) throw Object.assign(new Error('contract_too_large'), { stableCode: 'input_mismatch', retryable: false })
      const timestamp = String(Date.now())
      const signature = createHmac('sha256', workerSecret())
        .update(printWorkerSignaturePayload(timestamp, sha256(raw))).digest('hex')
      const response = await fetch(workerEndpoint(claimed.jobId), {
        method: 'POST', body: raw, signal: AbortSignal.timeout(Math.max(1, claimed.deadlineAt - Date.now() + 5_000)),
        headers: {
          'content-type': 'application/json',
          [PRINT_WORKER_TIMESTAMP_HEADER]: timestamp,
          [PRINT_WORKER_SIGNATURE_HEADER]: signature,
        },
      })
      if (!response.ok) {
        let code: PrintWorkerErrorCode | 'worker_unavailable' = response.status >= 500 ? 'worker_unavailable' : 'convert_failed'
        try {
          const value = await response.json() as { error?: { code?: PrintWorkerErrorCode } }
          if (value.error?.code) code = value.error.code
        } catch { /* stable status fallback */ }
        throw Object.assign(new Error(code), {
          stableCode: code,
          retryable: code === 'busy' || code === 'timeout' || code === 'output_failed' || code === 'worker_unavailable',
        })
      }
      if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) {
        throw Object.assign(new Error('bad_response'), { stableCode: 'worker_unavailable', retryable: true })
      }
      const rawResponse = new Uint8Array(await response.arrayBuffer())
      if (rawResponse.byteLength > PRINT_WORKER_MAX_BODY_BYTES) throw Object.assign(new Error('bad_response'), { stableCode: 'worker_unavailable', retryable: true })
      const result = decodeConvertResponseV1(JSON.parse(new TextDecoder().decode(rawResponse)))
      if (result.jobId !== claimed.jobId || result.output.contentType !== PRINT_WORKER_PDF_CONTENT_TYPE) {
        throw Object.assign(new Error('bad_response'), { stableCode: 'worker_unavailable', retryable: true })
      }
      const verifyClient = internalProductS3Client()
      try {
        const head = await verifyClient.send(new HeadObjectCommand({
          Bucket: productBucket(), Key: claimed.outputObjectKey, ChecksumMode: 'ENABLED',
        }))
        const actual = head.ChecksumSHA256 ?? head.Metadata?.sha256
        if (head.ContentLength !== result.output.size || head.ContentType !== PDF_CONTENT_TYPE ||
            (actual !== result.output.sha256 && actual !== checksumBase64(result.output.sha256))) {
          throw Object.assign(new Error('output_mismatch'), { stableCode: 'output_failed', retryable: true })
        }
      } finally { verifyClient.destroy() }
      await ctx.runMutation(completeRef, {
        jobId: claimed.jobId, leaseToken, attempt: claimed.attempt,
        output: { objectKey: claimed.outputObjectKey, ...result.output },
      })
      console.info(JSON.stringify({
        event: 'print_dispatch_succeeded',
        jobId: claimed.jobId,
        attempt: claimed.attempt,
        durationMs: Date.now() - startedAt,
        inputBytes: claimed.input.size,
        outputBytes: result.output.size,
      }))
    } catch (error) {
      const failure = workerFailure(error)
      console.error(JSON.stringify({
        event: 'print_dispatch_failed',
        jobId: claimed.jobId,
        attempt: claimed.attempt,
        durationMs: Date.now() - startedAt,
        code: failure.code,
        retryable: failure.retryable,
      }))
      await ctx.runMutation(failRef, {
        jobId: claimed.jobId, leaseToken, attempt: claimed.attempt,
        code: failure.code, retryable: failure.retryable,
      }).catch(() => undefined)
    }
  },
})

export const cleanupExpired = internalAction({
  args: {}, returns: undefined,
  handler: async (ctx) => {
    const now = Date.now()
    const artifacts = await ctx.runQuery(expiredRef, { now, limit: 500 })
    const client = internalProductS3Client()
    try {
      for (const artifact of artifacts) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: artifact.objectKey }))
          await ctx.runMutation(purgeArtifactRef, { id: artifact._id })
        } catch { /* retry at next cleanup tick */ }
      }
    } finally { client.destroy() }
    const jobs = await ctx.runMutation(purgeJobsRef, { now, limit: 500 })
    console.info(JSON.stringify({ event: 'print_cleanup', artifacts: artifacts.length, jobs }))
  },
})
