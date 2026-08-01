"use node"

import { parseAttendanceFile, unmatchedAttendanceDetail } from '@synie/shared'
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { action, internalAction } from '../../_generated/server'
import { readProductObject } from '../../files/s3'
import { synieError } from '../../lib/errors'

const currentUserRef = makeFunctionReference<'query', {}, { userId: string }>('files/domain:currentUserForAction')
const startRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendanceImport:startParse')
const stageRef = makeFunctionReference<'mutation', any, { inserted: number; matched: number; unmatched: number; unmatchedCounts: Record<string, number> }>('domains/hr/attendanceImport:stageChunk')
const finishParseRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendanceImport:finishParse')
const beginCommitRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendanceImport:beginCommit')
const rowsPageRef = makeFunctionReference<'query', any, { page: Array<{ _id: string }>; continueCursor: string; isDone: boolean }>('domains/hr/attendanceImport:rowsPage')
const commitChunkRef = makeFunctionReference<'mutation', any, { pairs: Array<{ employeeId: string; date: string }> }>('domains/hr/attendanceImport:commitChunk')
const finishCommitRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendanceImport:finishCommit')
const recalcRef = makeFunctionReference<'mutation', any, number>('domains/hr/attendance:recalcBatch')
const failRef = makeFunctionReference<'mutation', any, null>('jobs/domain:fail')
const beginRemoveRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendanceImport:beginRemove')
const factPageRef = makeFunctionReference<'query', any, { page: Array<{ _id: string; employeeId: string; date: string }>; continueCursor: string; isDone: boolean }>('domains/hr/attendanceImport:factPage')
const removeFactsRef = makeFunctionReference<'mutation', any, null>('domains/hr/attendanceImport:removeFacts')
const finishRemoveRef = makeFunctionReference<'mutation', any, null>('domains/hr/attendanceImport:finishRemove')
const claimRef = makeFunctionReference<'mutation', any, any>('jobs/domain:claim')
const resumePlanRef = makeFunctionReference<'query', any, any>('domains/hr/attendanceImport:resumePlan')
const startBuildRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendance:startProjectionBuild')
const generationPageRef = makeFunctionReference<'query', any, { page: any[]; continueCursor: string; isDone: boolean }>('domains/hr/attendance:projectionGenerationPage')
const copyProjectionRef = makeFunctionReference<'mutation', any, number>('domains/hr/attendance:copyProjectionChunk')
const rebuildProjectionRef = makeFunctionReference<'mutation', any, number>('domains/hr/attendance:rebuildProjectionChunk')
const verifyProjectionRef = makeFunctionReference<'mutation', any, any>('domains/hr/attendance:verifyProjectionBuild')

async function hashRows(rows: readonly unknown[]): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)))).toString('hex')
}

async function runParse(ctx: any, jobId: string, token: string, objectKey: string) {
  let parsed
  try {
    parsed = parseAttendanceFile(await readProductObject(objectKey, 50 * 1024 * 1024))
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法解析考勤文件'
    return ctx.runMutation(finishParseRef, {
      jobId, token, error: message, totalRows: 0, badRows: 0, dupRows: 0,
      matchedRows: 0, unmatchedRows: 0,
    })
  }
  let matchedRows = 0; let unmatchedRows = 0
  const unmatched = new Map<string, number>()
  try {
    const rows = parsed.rows.map((row, index) => ({ rowNo: index + 1, attendanceNo: row.attendanceNo, punchedAt: row.punchedAt.toISOString() }))
    for (let offset = 0, chunkNo = 0; offset < rows.length; offset += 500, chunkNo += 1) {
      const chunk = rows.slice(offset, offset + 500)
      const result = await ctx.runMutation(stageRef, { jobId, token, chunkNo, hash: await hashRows(chunk), rows: chunk })
      matchedRows += result.matched; unmatchedRows += result.unmatched
        for (const [key, count] of Object.entries(result.unmatchedCounts)) unmatched.set(key, (unmatched.get(key) ?? 0) + Number(count))
    }
    return ctx.runMutation(finishParseRef, {
      jobId, token, totalRows: parsed.totalRows, badRows: parsed.badRows, dupRows: parsed.dupRows,
      matchedRows, unmatchedRows, unmatchedDetail: unmatchedAttendanceDetail(unmatched) ?? undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '考勤解析任务失败'
    await ctx.runMutation(failRef, { id: jobId, token, code: 'attendance_parse', message }).catch(() => undefined)
    throw synieError('internal', '考勤解析暂时失败,任务可安全重试')
  }
}

async function allImportPairs(ctx: any, importId: string) {
  const pairs = new Map<string, { employeeId: string; date: string }>()
  let cursor: string | null = null
  do {
    const page: { page: Array<{ employeeId: string; date: string }>; continueCursor: string; isDone: boolean } = await ctx.runQuery(factPageRef, {
      importId, paginationOpts: { numItems: 500, cursor },
    })
    for (const fact of page.page) pairs.set(`${fact.employeeId}\0${fact.date}`, { employeeId: fact.employeeId, date: fact.date })
    cursor = page.isDone ? null : page.continueCursor
  } while (cursor)
  return [...pairs.values()]
}

async function runCommit(ctx: any, jobId: string, token: string, parseJobId: string, userId: string, importId: string) {
  try {
    let cursor: string | null = null
    do {
      const page: { page: Array<{ _id: string }>; continueCursor: string; isDone: boolean } = await ctx.runQuery(rowsPageRef, {
        jobId: parseJobId, paginationOpts: { numItems: 500, cursor },
      })
      for (let offset = 0; offset < page.page.length; offset += 200) {
        await ctx.runMutation(commitChunkRef, {
          jobId, token, rowIds: page.page.slice(offset, offset + 200).map((row) => row._id),
        })
      }
      cursor = page.isDone ? null : page.continueCursor
    } while (cursor)
    const pairs = await allImportPairs(ctx, importId)
    const build = await ctx.runMutation(startBuildRef, { jobId, token })
    if (build.state === 'verified') {
      return ctx.runMutation(finishCommitRef, {
        jobId, token, buildId: build._id, targetGeneration: build.targetGeneration,
      })
    }
    if (build.state !== 'building') throw new Error('考勤投影构建状态不可恢复')
    let copiedRows = 0
    let sourceCursor: string | null = null
    do {
      const page: { page: any[]; continueCursor: string; isDone: boolean } = await ctx.runQuery(generationPageRef, {
        generation: build.sourceGeneration,
        paginationOpts: { numItems: 250, cursor: sourceCursor },
      })
      for (let offset = 0; offset < page.page.length; offset += 100) {
        await ctx.runMutation(copyProjectionRef, {
          jobId, token, buildId: build._id, rows: page.page.slice(offset, offset + 100),
        })
      }
      copiedRows += page.page.length
      sourceCursor = page.isDone ? null : page.continueCursor
    } while (sourceCursor)
    const rebuiltPairs = pairs.length
    for (let offset = 0; offset < pairs.length; offset += 25) {
      await ctx.runMutation(rebuildProjectionRef, {
        jobId, token, buildId: build._id, importId, pairs: pairs.slice(offset, offset + 25),
      })
    }
    let targetRows = 0
    let targetCursor: string | null = null
    do {
      const page: { page: any[]; continueCursor: string; isDone: boolean } = await ctx.runQuery(generationPageRef, {
        generation: build.targetGeneration,
        paginationOpts: { numItems: 500, cursor: targetCursor },
      })
      targetRows += page.page.length
      targetCursor = page.isDone ? null : page.continueCursor
    } while (targetCursor)
    const verified = await ctx.runMutation(verifyProjectionRef, {
      jobId, token, buildId: build._id, copiedRows, rebuiltPairs, targetRows,
    })
    return ctx.runMutation(finishCommitRef, {
      jobId, token, buildId: build._id, targetGeneration: verified.targetGeneration,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '考勤提交失败'
    await ctx.runMutation(failRef, { id: jobId, token, code: 'attendance_commit', message }).catch(() => undefined)
    throw error
  }
}

export const create = action({
  args: { fileId: v.id('files') }, returns: v.any(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const token = crypto.randomUUID()
    const started = await ctx.runMutation(startRef, { userId, fileId: args.fileId, token })
    if (started.completed) return started.record
    return runParse(ctx, started.jobId as string, token, started.file.objectKey)
  },
})

export const commit = action({
  args: { importId: v.string(), autoCreateEmployees: v.boolean() }, returns: v.any(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    const token = crypto.randomUUID()
    const started = await ctx.runMutation(beginCommitRef, { userId, ...args, token })
    if (started.completed) return started.record
    return runCommit(ctx, started.jobId, token, started.parseJobId, userId, args.importId)
  },
})

export const remove = action({
  args: { importId: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const { userId } = await ctx.runQuery(currentUserRef, {})
    await ctx.runMutation(beginRemoveRef, { userId, importId: args.importId })
    const pairs = new Map<string, { employeeId: string; date: string }>()
    while (true) {
      const page: { page: Array<{ _id: string; employeeId: string; date: string }>; continueCursor: string; isDone: boolean } = await ctx.runQuery(factPageRef, {
        importId: args.importId, paginationOpts: { numItems: 500, cursor: null },
      })
      if (!page.page.length) break
      for (const fact of page.page) pairs.set(`${fact.employeeId}\0${fact.date}`, { employeeId: fact.employeeId, date: fact.date })
      await ctx.runMutation(removeFactsRef, { ids: page.page.map((fact) => fact._id) })
      if (page.isDone) break
    }
    await ctx.runMutation(finishRemoveRef, { userId, importId: args.importId })
    const ordered = [...pairs.values()]
    for (let offset = 0; offset < ordered.length; offset += 25) await ctx.runMutation(recalcRef, { userId, pairs: ordered.slice(offset, offset + 25) })
    return null
  },
})

export const resume = internalAction({
  args: { jobId: v.id('ioJobs') }, returns: v.any(),
  handler: async (ctx, args) => {
    const token = crypto.randomUUID()
    const claimed = await ctx.runMutation(claimRef, { id: args.jobId, token, leaseMs: 10 * 60_000 })
    if (claimed.status !== 'running') return null
    const plan = await ctx.runQuery(resumePlanRef, { jobId: args.jobId, token })
    return plan.kind === 'attendance_import_parse'
      ? runParse(ctx, String(args.jobId), token, plan.file.objectKey)
      : runCommit(ctx, String(args.jobId), token, plan.parseJobId, String(plan.userId), plan.importId)
  },
})
