"use node"

import { parseBankImport, type ParseTemplate } from '@synie/shared'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action, internalAction } from '../../_generated/server'
import { synieError } from '../../lib/errors'
import { readProductObject } from '../../files/s3'

type StartResult = {
  completed: boolean; record?: unknown; jobId?: string; token?: string
  file?: { objectKey: string; size: number }; template?: ParseTemplate
}
const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>('files/domain:currentUserForAction')
const startRef = makeFunctionReference<'mutation', {
  userId: string; companyId: string; bankAccountId: string; templateId: string; fileId: string; token: string
}, StartResult>('domains/finance/bankImport:startParse')
const stageRef = makeFunctionReference<'mutation', {
  jobId: string; token: string; chunkNo: number; hash: string; rows: unknown[]
}, { inserted: number }>('domains/finance/bankImport:stageChunk')
const finishParseRef = makeFunctionReference<'mutation', {
  jobId: string; token: string; error?: string; itemCount: number; errorCount: number
}, unknown>('domains/finance/bankImport:finishParse')
const beginCommitRef = makeFunctionReference<'mutation', {
  userId: string; importId: string; token: string
}, { completed: boolean; record?: unknown; jobId?: string; parseJobId?: string }>('domains/finance/bankImport:beginCommit')
const rowsPageRef = makeFunctionReference<'query', {
  jobId: string; paginationOpts: { numItems: number; cursor: string | null }
}, { page: Array<{ _id: string }>; continueCursor: string; isDone: boolean }>('domains/finance/bankImport:rowsPage')
const commitChunkRef = makeFunctionReference<'mutation', {
  jobId: string; token: string; rowIds: string[]
}, number>('domains/finance/bankImport:commitChunk')
const finishCommitRef = makeFunctionReference<'mutation', { jobId: string; token: string }, unknown>('domains/finance/bankImport:finishCommit')
const failRef = makeFunctionReference<'mutation', {
  id: string; token: string; code: string; message: string
}, null>('jobs/domain:fail')
const claimRef = makeFunctionReference<'mutation', { id: string; token: string; leaseMs?: number }, any>('jobs/domain:claim')
const resumePlanRef = makeFunctionReference<'query', { jobId: string; token: string }, {
  kind: 'bank_import_parse' | 'bank_import_commit'; file?: { objectKey: string }
  template?: ParseTemplate; parseJobId?: string
}>('domains/finance/bankImport:resumePlan')
const beginRemoveRef = makeFunctionReference<'mutation', { userId: string; id: string }, { parseJobId: string }>('domains/finance/bankImport:beginRemoveImport')
const removeRowsRef = makeFunctionReference<'mutation', { parseJobId: string }, { removed: number; done: boolean }>('domains/finance/bankImport:removeImportRowChunk')
const finishRemoveRef = makeFunctionReference<'mutation', { userId: string; id: string }, null>('domains/finance/bankImport:finishRemoveImport')

async function hashRows(rows: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows))
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
}

async function runParse(ctx: any, jobId: string, token: string, objectKey: string, template: ParseTemplate) {
  try {
    const bytes = await readProductObject(objectKey, 50 * 1024 * 1024)
    let rows: ReturnType<typeof parseBankImport>
    try {
      rows = parseBankImport(template, bytes)
    } catch (error) {
      return ctx.runMutation(finishParseRef, {
        jobId, token, error: error instanceof Error ? error.message : '无法解析银行流水文件',
        itemCount: 0, errorCount: 0,
      })
    }
    const staged = rows.map((row) => ({ ...row, occurredAt: row.occurredAt?.toISOString() ?? null }))
    let errorCount = 0
    for (let offset = 0, chunkNo = 0; offset < staged.length; offset += 250, chunkNo += 1) {
      const chunk = staged.slice(offset, offset + 250)
      errorCount += chunk.filter((row) => row.error).length
      await ctx.runMutation(stageRef, { jobId, token, chunkNo, hash: await hashRows(chunk), rows: chunk })
    }
    return ctx.runMutation(finishParseRef, { jobId, token, itemCount: staged.length, errorCount })
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取银行流水文件失败'
    await ctx.runMutation(failRef, { id: jobId, token, code: 'bank_import_io', message }).catch(() => undefined)
    throw synieError('internal', '银行流水解析暂时失败,任务可安全重试')
  }
}

async function runCommit(ctx: any, jobId: string, token: string, parseJobId: string) {
  try {
    let cursor: string | null = null
    do {
      const page: { page: Array<{ _id: string }>; continueCursor: string; isDone: boolean } = await ctx.runQuery(rowsPageRef, {
        jobId: parseJobId, paginationOpts: { numItems: 100, cursor },
      })
      for (let offset = 0; offset < page.page.length; offset += 20) {
        await ctx.runMutation(commitChunkRef, {
          jobId, token, rowIds: page.page.slice(offset, offset + 20).map((row) => row._id),
        })
      }
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor)
    return ctx.runMutation(finishCommitRef, { jobId, token })
  } catch (error) {
    const message = error instanceof Error ? error.message : '银行流水提交失败'
    await ctx.runMutation(failRef, { id: jobId, token, code: 'bank_import_commit', message }).catch(() => undefined)
    throw error
  }
}

export const create = action({
  args: { companyId: v.string(), bankAccountId: v.string(), templateId: v.string(), fileId: v.id('files') },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const token = crypto.randomUUID()
    const started = await ctx.runMutation(startRef, { ...args, userId, token })
    if (started.completed) return started.record
    return runParse(ctx, started.jobId!, token, started.file!.objectKey, started.template!)
  },
})

export const commit = action({
  args: { importId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const token = crypto.randomUUID()
    const started = await ctx.runMutation(beginCommitRef, { userId, importId: args.importId, token })
    if (started.completed) return started.record
    return runCommit(ctx, started.jobId!, token, started.parseJobId!)
  },
})

export const resume = internalAction({
  args: { jobId: v.id('ioJobs') }, returns: v.any(),
  handler: async (ctx, args) => {
    const token = crypto.randomUUID()
    const claimed = await ctx.runMutation(claimRef, { id: args.jobId, token, leaseMs: 10 * 60_000 })
    if (claimed.status !== 'running') return null
    const plan = await ctx.runQuery(resumePlanRef, { jobId: args.jobId, token })
    return plan.kind === 'bank_import_parse'
      ? runParse(ctx, String(args.jobId), token, plan.file!.objectKey, plan.template!)
      : runCommit(ctx, String(args.jobId), token, plan.parseJobId!)
  },
})

export const remove = action({
  args: { importId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const started = await ctx.runMutation(beginRemoveRef, { userId, id: args.importId })
    while (true) {
      const result = await ctx.runMutation(removeRowsRef, { parseJobId: started.parseJobId })
      if (result.done) break
    }
    await ctx.runMutation(finishRemoveRef, { userId, id: args.importId })
    return null
  },
})
