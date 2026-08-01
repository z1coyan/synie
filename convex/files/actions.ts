"use node"

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action } from '../_generated/server'
import { synieError } from '../lib/errors'
import {
  internalProductS3Client,
  productBucket,
  publicProductS3Client,
} from './s3'

type Intent = {
  status: 'pending' | 'finalized' | 'failed'; expiresAt: number; sha256: string
  size: number; contentType: string; objectKey: string; finalObjectKey?: string
}
type FileDescriptor = { objectKey: string; filename: string; contentType: string | null }
const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>('files/domain:currentUserForAction')
const intentRef = makeFunctionReference<'query', { id: string; userId: string }, Intent>('files/domain:intentForAction')
const finalizeRef = makeFunctionReference<'mutation', { id: string; userId: string }, unknown>('files/domain:finalizeIntent')
const failRef = makeFunctionReference<'mutation', { id: string; userId: string; code: string }, null>('files/domain:failIntent')
const downloadRef = makeFunctionReference<'query', { fileId: string; userId: string }, FileDescriptor>('files/domain:authorizeDownload')
const beginDeleteRef = makeFunctionReference<'mutation', { fileId: string; userId: string }, { objectKey: string } | null>('files/domain:beginDelete')
const finishDeleteRef = makeFunctionReference<'mutation', { fileId: string }, null>('files/domain:finishDelete')
const failDeleteRef = makeFunctionReference<'mutation', { fileId: string; message: string }, null>('files/domain:failDelete')

function checksumBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

function disposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return value.name === 'NotFound' || value.name === 'NoSuchKey' || value.$metadata?.httpStatusCode === 404
}

async function headObject(
  client: ReturnType<typeof internalProductS3Client>,
  key: string,
) {
  try {
    return await client.send(new HeadObjectCommand({
      Bucket: productBucket(), Key: key, ChecksumMode: 'ENABLED',
    }))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function objectMatches(
  head: Awaited<ReturnType<typeof headObject>>,
  intent: Intent,
): boolean {
  if (!head) return false
  const actualChecksum = head.ChecksumSHA256 ?? head.Metadata?.sha256
  return head.ContentLength === intent.size &&
    head.ContentType === intent.contentType &&
    (actualChecksum === checksumBase64(intent.sha256) || actualChecksum === intent.sha256)
}

function copySource(key: string): string {
  return encodeURIComponent(`${productBucket()}/${key}`).replaceAll('%2F', '/')
}

export const signUpload = action({
  args: { intentId: v.id('uploadIntents') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await ctx.runQuery(currentUserRef, {})
    const intent = await ctx.runQuery(intentRef, { id: args.intentId, userId: actor.userId })
    if (intent.status === 'finalized') return { finalized: true }
    if (intent.status !== 'pending' || intent.expiresAt < Date.now()) throw synieError('conflict', '上传凭据已失效')
    const checksum = checksumBase64(intent.sha256)
    const publicClient = publicProductS3Client()
    const url = await getSignedUrl(publicClient, new PutObjectCommand({
      Bucket: productBucket(), Key: intent.objectKey, ContentLength: intent.size,
      ContentType: intent.contentType, ChecksumSHA256: checksum,
      Metadata: { sha256: intent.sha256 },
    }), {
      expiresIn: 600,
      signableHeaders: new Set(['content-type']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-meta-sha256']),
    })
    publicClient.destroy()
    return {
      finalized: false,
      url,
      headers: {
        'content-type': intent.contentType,
        'x-amz-checksum-sha256': checksum,
        'x-amz-meta-sha256': intent.sha256,
      },
      expiresAt: intent.expiresAt,
    }
  },
})

export const finalizeUpload = action({
  args: { intentId: v.id('uploadIntents') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await ctx.runQuery(currentUserRef, {})
    const intent = await ctx.runQuery(intentRef, { id: args.intentId, userId: actor.userId })
    if (intent.status === 'finalized') {
      return ctx.runMutation(finalizeRef, { id: args.intentId, userId: actor.userId })
    }
    if (intent.status !== 'pending' || intent.expiresAt < Date.now()) throw synieError('conflict', '上传凭据已失效')
    const internalClient = internalProductS3Client()
    try {
      const finalObjectKey = intent.finalObjectKey ?? intent.objectKey
      const staged = await headObject(internalClient, intent.objectKey)
      if (staged && !objectMatches(staged, intent)) {
        await internalClient.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: intent.objectKey }))
        await ctx.runMutation(failRef, { id: args.intentId, userId: actor.userId, code: 'object_mismatch' })
        throw synieError('validation', '上传文件校验失败，请重新选择文件')
      }
      if (finalObjectKey !== intent.objectKey) {
        const existingFinal = await headObject(internalClient, finalObjectKey)
        if (existingFinal && !objectMatches(existingFinal, intent)) {
          await internalClient.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: finalObjectKey }))
          await ctx.runMutation(failRef, { id: args.intentId, userId: actor.userId, code: 'object_mismatch' })
          throw synieError('validation', '上传文件校验失败，请重新选择文件')
        }
        if (!existingFinal) {
          if (!staged) throw synieError('validation', '尚未收到完整文件，请重试上传')
          await internalClient.send(new CopyObjectCommand({
            Bucket: productBucket(), Key: finalObjectKey,
            CopySource: copySource(intent.objectKey),
            ChecksumAlgorithm: 'SHA256', MetadataDirective: 'REPLACE',
            ContentType: intent.contentType, Metadata: { sha256: intent.sha256 },
          }))
          if (!objectMatches(await headObject(internalClient, finalObjectKey), intent)) {
            await internalClient.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: finalObjectKey }))
            throw synieError('validation', '上传文件校验失败，请重新选择文件')
          }
        }
        if (staged) {
          await internalClient.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: intent.objectKey }))
        }
      } else if (!staged) {
        throw synieError('validation', '尚未收到完整文件，请重试上传')
      }
      const result = await ctx.runMutation(finalizeRef, { id: args.intentId, userId: actor.userId })
      return result
    } catch (error) {
      if (error instanceof Error &&
          (error.message.includes('上传文件校验失败') || error.message.includes('尚未收到完整文件'))) throw error
      throw synieError('validation', '尚未收到完整文件，请重试上传')
    } finally {
      internalClient.destroy()
    }
  },
})

export const downloadUrl = action({
  args: { fileId: v.id('files') }, returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await ctx.runQuery(currentUserRef, {})
    const file = await ctx.runQuery(downloadRef, { fileId: args.fileId, userId: actor.userId })
    const publicClient = publicProductS3Client()
    const url = await getSignedUrl(publicClient, new GetObjectCommand({
      Bucket: productBucket(), Key: file.objectKey,
      ResponseContentType: file.contentType ?? 'application/octet-stream',
      ResponseContentDisposition: disposition(file.filename),
    }), { expiresIn: 300 })
    publicClient.destroy()
    return { url, expiresAt: Date.now() + 300_000, filename: file.filename, contentType: file.contentType }
  },
})

export const removeFile = action({
  args: { fileId: v.id('files') }, returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await ctx.runQuery(currentUserRef, {})
    const descriptor = await ctx.runMutation(beginDeleteRef, { fileId: args.fileId, userId: actor.userId })
    if (!descriptor) return null
    const internalClient = internalProductS3Client()
    try {
      await internalClient.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: descriptor.objectKey }))
      await ctx.runMutation(finishDeleteRef, { fileId: args.fileId })
      return null
    } catch (error) {
      await ctx.runMutation(failDeleteRef, {
        fileId: args.fileId,
        message: error instanceof Error ? error.message : 'S3 删除失败',
      }).catch(() => undefined)
      throw synieError('internal', '文件删除失败，后台将继续重试')
    } finally {
      internalClient.destroy()
    }
  },
})
