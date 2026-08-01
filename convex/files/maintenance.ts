"use node"

import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction } from '../_generated/server'
import { deleteProductObject, internalProductS3Client, productBucket } from './s3'

type Intent = { _id: string; objectKey: string; finalObjectKey?: string }
type DeleteJob = { fileId: string; objectKey: string }
type FileRow = { _id: string; objectKey: string; sha256: string }
type Page = { page: FileRow[]; continueCursor: string; isDone: boolean }

const startRef = makeFunctionReference<'mutation', {
  kind: 'file_cleanup' | 's3_reconcile'; idempotencyKey: string; token: string
}, any>('files/domain:startMaintenance')
const claimRef = makeFunctionReference<'mutation', { id: string; token: string; leaseMs?: number }, any>('jobs/domain:claim')
const failRef = makeFunctionReference<'mutation', { id: string; token: string; code: string; message: string }, null>('jobs/domain:fail')
const finishRef = makeFunctionReference<'mutation', { jobId: string; token: string; result: unknown }, unknown>('files/domain:finishMaintenance')
const expiredRef = makeFunctionReference<'query', { now: number; limit?: number }, Intent[]>('files/domain:expiredIntents')
const expireRef = makeFunctionReference<'mutation', { id: string }, null>('files/domain:expireIntent')
const dueDeleteRef = makeFunctionReference<'query', { now: number; limit?: number }, DeleteJob[]>('files/domain:dueDeleteJobs')
const finishDeleteRef = makeFunctionReference<'mutation', { fileId: string }, null>('files/domain:finishDelete')
const failDeleteRef = makeFunctionReference<'mutation', { fileId: string; message: string }, null>('files/domain:failDelete')
const objectPageRef = makeFunctionReference<'query', {
  paginationOpts: { numItems: number; cursor: string | null }
}, Page>('files/domain:maintenanceObjectPage')
const pendingKeysRef = makeFunctionReference<'query', { now: number }, string[]>('files/domain:pendingIntentKeys')
const startRunRef = makeFunctionReference<'mutation', {}, string>('files/domain:startReconciliationRun')
const finishRunRef = makeFunctionReference<'mutation', any, null>('files/domain:finishReconciliationRun')

async function cleanup(ctx: any, jobId: string, token: string) {
  const now = Date.now()
  const expired = await ctx.runQuery(expiredRef, { now, limit: 500 })
  let expiredCleaned = 0
  for (const intent of expired) {
    try {
      await deleteProductObject(intent.objectKey)
      if (intent.finalObjectKey && intent.finalObjectKey !== intent.objectKey) {
        await deleteProductObject(intent.finalObjectKey)
      }
      await ctx.runMutation(expireRef, { id: intent._id })
      expiredCleaned += 1
    } catch {
      // Keep the intent pending so a later durable run retries the object delete.
    }
  }
  const deletionJobs = await ctx.runQuery(dueDeleteRef, { now, limit: 500 })
  let filesDeleted = 0
  let deleteFailures = 0
  for (const pending of deletionJobs) {
    try {
      await deleteProductObject(pending.objectKey)
      await ctx.runMutation(finishDeleteRef, { fileId: pending.fileId })
      filesDeleted += 1
    } catch (error) {
      deleteFailures += 1
      await ctx.runMutation(failDeleteRef, {
        fileId: pending.fileId,
        message: error instanceof Error ? error.message : 'S3 删除失败',
      })
    }
  }
  return ctx.runMutation(finishRef, {
    jobId, token, result: { expiredCleaned, filesDeleted, deleteFailures },
  })
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return value.name === 'NotFound' || value.name === 'NoSuchKey' || value.$metadata?.httpStatusCode === 404
}

async function reconcile(ctx: any, jobId: string, token: string) {
  const runId = await ctx.runMutation(startRunRef, {})
  const files: FileRow[] = []
  let cursor: string | null = null
  do {
    const page: Page = await ctx.runQuery(objectPageRef, { paginationOpts: { numItems: 500, cursor } })
    files.push(...page.page)
    cursor = page.isDone ? null : page.continueCursor
  } while (cursor)
  const known = new Set(files.map((file) => file.objectKey))
  for (const key of await ctx.runQuery(pendingKeysRef, { now: Date.now() })) known.add(key)

  const client = internalProductS3Client()
  const objects = new Set<string>()
  const missingObjectKeys: string[] = []
  const checksumMismatchFileIds: string[] = []
  try {
    let continuationToken: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: productBucket(), Prefix: 'files/', ContinuationToken: continuationToken,
      }))
      for (const object of page.Contents ?? []) if (object.Key) objects.add(object.Key)
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken)

    for (const file of files) {
      try {
        const head = await client.send(new HeadObjectCommand({
          Bucket: productBucket(), Key: file.objectKey, ChecksumMode: 'ENABLED',
        }))
        const expected = Buffer.from(file.sha256, 'hex').toString('base64')
        const actual = head.ChecksumSHA256 ?? head.Metadata?.sha256
        if (actual !== expected && actual !== file.sha256) checksumMismatchFileIds.push(file._id)
      } catch (error) {
        if (isMissing(error)) missingObjectKeys.push(file.objectKey)
        else throw error
      }
    }
    const orphanObjectKeys = [...objects].filter((key) => !known.has(key))
    const truncated = missingObjectKeys.length > 500 || orphanObjectKeys.length > 500 || checksumMismatchFileIds.length > 500
    const report = {
      metadataCount: files.length, objectCount: objects.size,
      missingObjectKeys: missingObjectKeys.slice(0, 500),
      orphanObjectKeys: orphanObjectKeys.slice(0, 500),
      checksumMismatchFileIds: checksumMismatchFileIds.slice(0, 500), truncated,
    }
    await ctx.runMutation(finishRunRef, { id: runId, status: 'succeeded', ...report, error: null })
    return ctx.runMutation(finishRef, { jobId, token, result: { runId, ...report } })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'S3 inventory 失败'
    await ctx.runMutation(finishRunRef, {
      id: runId, status: 'failed', metadataCount: files.length, objectCount: objects.size,
      missingObjectKeys: missingObjectKeys.slice(0, 500), orphanObjectKeys: [],
      checksumMismatchFileIds: checksumMismatchFileIds.slice(0, 500), truncated: false, error: message,
    }).catch(() => undefined)
    throw error
  } finally {
    client.destroy()
  }
}

async function runExisting(ctx: any, jobId: string, kind: 'file_cleanup' | 's3_reconcile') {
  const token = crypto.randomUUID()
  const claimed = await ctx.runMutation(claimRef, { id: jobId, token, leaseMs: 10 * 60_000 })
  if (claimed.status !== 'running' || claimed.kind !== kind) return null
  try {
    return kind === 'file_cleanup' ? await cleanup(ctx, jobId, token) : await reconcile(ctx, jobId, token)
  } catch (error) {
    await ctx.runMutation(failRef, {
      id: jobId, token, code: kind,
      message: error instanceof Error ? error.message : '文件维护任务失败',
    }).catch(() => undefined)
    throw error
  }
}

async function schedule(ctx: any, kind: 'file_cleanup' | 's3_reconcile', slotMs: number) {
  const now = Date.now()
  const token = crypto.randomUUID()
  const started = await ctx.runMutation(startRef, {
    kind, idempotencyKey: `${kind}:${Math.floor(now / slotMs)}`, token,
  })
  if (started.completed) return started.result ?? null
  try {
    return kind === 'file_cleanup'
      ? await cleanup(ctx, started.jobId, token)
      : await reconcile(ctx, started.jobId, token)
  } catch (error) {
    await ctx.runMutation(failRef, {
      id: started.jobId, token, code: kind,
      message: error instanceof Error ? error.message : '文件维护任务失败',
    }).catch(() => undefined)
    throw error
  }
}

export const scheduleCleanup = internalAction({
  args: {}, returns: v.any(),
  handler: (ctx) => schedule(ctx, 'file_cleanup', 15 * 60_000),
})

export const scheduleReconciliation = internalAction({
  args: {}, returns: v.any(),
  handler: (ctx) => schedule(ctx, 's3_reconcile', 24 * 60 * 60_000),
})

export const runCleanupJob = internalAction({
  args: { jobId: v.id('ioJobs') }, returns: v.any(),
  handler: (ctx, args) => runExisting(ctx, String(args.jobId), 'file_cleanup'),
})

export const runReconciliationJob = internalAction({
  args: { jobId: v.id('ioJobs') }, returns: v.any(),
  handler: (ctx, args) => runExisting(ctx, String(args.jobId), 's3_reconcile'),
})
