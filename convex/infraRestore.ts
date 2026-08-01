import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'

type RestoreFixtureRecord = {
  marker: string
  storageId: Id<'_storage'>
  expectedSha256: string
}

type RestoreFixtureResult = RestoreFixtureRecord & {
  contentType: string
  bytes: ArrayBuffer
}

export const replaceFixtureRecord = internalMutation({
  args: {
    marker: v.string(),
    storageId: v.id('_storage'),
    expectedSha256: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // The table is reserved for this drill. Clearing every row also upgrades
    // the record-only fixture created by the first Plan 001 implementation.
    const previous = await ctx.db.query('infraRestoreSmoke').collect()

    for (const document of previous) {
      if (document.storageId) await ctx.storage.delete(document.storageId)
      if (document.productFileId) {
        const productFile = await ctx.db.get(document.productFileId)
        if (productFile) await ctx.db.delete(productFile._id)
      }
      await ctx.db.delete(document._id)
    }
    await ctx.db.insert('infraRestoreSmoke', args)
    return null
  },
})

export const registerProductFixture = internalMutation({
  args: {
    marker: v.string(),
    objectKey: v.string(),
    expectedSha256: v.string(),
    size: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    fileId: v.id('files'),
    objectKey: v.string(),
    expectedSha256: v.string(),
  }),
  handler: async (ctx, args) => {
    if (!args.objectKey.startsWith('files/restore-smoke/')) {
      throw new Error('产品文件恢复 fixture 必须使用专用前缀')
    }
    if (!/^[0-9a-f]{64}$/.test(args.expectedSha256)) {
      throw new Error('产品文件 expectedSha256 必须是 64 位小写十六进制')
    }
    if (!Number.isSafeInteger(args.size) || args.size <= 0) {
      throw new Error('产品文件 fixture 大小无效')
    }
    const fixture = await ctx.db
      .query('infraRestoreSmoke')
      .withIndex('by_marker', (query) => query.eq('marker', args.marker))
      .unique()
    if (!fixture) throw new Error(`恢复演练记录不存在：${args.marker}`)

    if (fixture.productFileId) {
      const previous = await ctx.db.get(fixture.productFileId)
      if (previous) await ctx.db.delete(previous._id)
    }
    const authUserId = 'infra-restore-smoke-product-file-owner'
    let owner = await ctx.db
      .query('appUsers')
      .withIndex('by_auth_user', (query) => query.eq('authUserId', authUserId))
      .unique()
    if (!owner) {
      const now = Date.now()
      const ownerId = await ctx.db.insert('appUsers', {
        authUserId,
        usernameKey: authUserId,
        username: authUserId,
        name: '恢复演练文件所有者',
        enabled: false,
        superAdmin: false,
        allCompanies: false,
        insertedAt: now,
        updatedAt: now,
      })
      owner = await ctx.db.get(ownerId)
    }
    if (!owner) throw new Error('无法创建产品文件恢复 fixture 所有者')

    const fileId = await ctx.db.insert('files', {
      objectKey: args.objectKey,
      filename: 'convex-product-file-restore-smoke.bin',
      contentType: args.contentType,
      size: args.size,
      sha256: args.expectedSha256,
      uploadedById: owner._id,
      status: 'ready',
      insertedAt: Date.now(),
    })
    await ctx.db.patch(fixture._id, {
      productFileId: fileId,
      productObjectKey: args.objectKey,
      productExpectedSha256: args.expectedSha256,
    })
    return { fileId, objectKey: args.objectKey, expectedSha256: args.expectedSha256 }
  },
})

export const productFixture = internalQuery({
  args: { marker: v.string() },
  returns: v.object({
    fileId: v.id('files'),
    objectKey: v.string(),
    expectedSha256: v.string(),
    size: v.number(),
    contentType: v.string(),
  }),
  handler: async (ctx, args) => {
    const fixture = await ctx.db
      .query('infraRestoreSmoke')
      .withIndex('by_marker', (query) => query.eq('marker', args.marker))
      .unique()
    if (!fixture?.productFileId || !fixture.productObjectKey || !fixture.productExpectedSha256) {
      throw new Error(`产品文件恢复演练记录不存在：${args.marker}`)
    }
    const file = await ctx.db.get(fixture.productFileId)
    if (!file || file.status !== 'ready') throw new Error('产品文件恢复演练元数据不存在')
    if (
      file.objectKey !== fixture.productObjectKey ||
      file.sha256 !== fixture.productExpectedSha256 ||
      !file.contentType
    ) {
      throw new Error('产品文件恢复演练元数据不一致')
    }
    return {
      fileId: file._id,
      objectKey: file.objectKey,
      expectedSha256: file.sha256,
      size: file.size,
      contentType: file.contentType,
    }
  },
})

export const fixtureRecord = internalQuery({
  args: { marker: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      marker: v.string(),
      storageId: v.id('_storage'),
      expectedSha256: v.string(),
    }),
  ),
  handler: async (ctx, args): Promise<RestoreFixtureRecord | null> => {
    const document = await ctx.db
      .query('infraRestoreSmoke')
      .withIndex('by_marker', (query) => query.eq('marker', args.marker))
      .unique()
    if (!document) return null
    if (!document.marker || !document.storageId || !document.expectedSha256) {
      throw new Error(`恢复演练记录结构无效：${args.marker}`)
    }
    return {
      marker: document.marker,
      storageId: document.storageId,
      expectedSha256: document.expectedSha256,
    }
  },
})

export const writeFixture = internalAction({
  args: {
    marker: v.string(),
    bytes: v.bytes(),
    expectedSha256: v.string(),
  },
  returns: v.object({
    marker: v.string(),
    storageId: v.id('_storage'),
    expectedSha256: v.string(),
    byteLength: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!/^[0-9a-f]{64}$/.test(args.expectedSha256)) {
      throw new Error('expectedSha256 必须是 64 位小写十六进制')
    }
    if (args.bytes.byteLength === 0) throw new Error('恢复演练文件不能为空')

    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: 'application/octet-stream' }),
    )
    try {
      await ctx.runMutation(internal.infraRestore.replaceFixtureRecord, {
        marker: args.marker,
        storageId,
        expectedSha256: args.expectedSha256,
      })
    } catch (error) {
      await ctx.storage.delete(storageId)
      throw error
    }

    return {
      marker: args.marker,
      storageId,
      expectedSha256: args.expectedSha256,
      byteLength: args.bytes.byteLength,
    }
  },
})

export const readFixture = internalAction({
  args: { marker: v.string() },
  returns: v.object({
    marker: v.string(),
    storageId: v.id('_storage'),
    expectedSha256: v.string(),
    contentType: v.string(),
    bytes: v.bytes(),
  }),
  handler: async (ctx, args): Promise<RestoreFixtureResult> => {
    const document: RestoreFixtureRecord | null = await ctx.runQuery(
      internal.infraRestore.fixtureRecord,
      args,
    )
    if (!document) throw new Error(`恢复演练记录不存在：${args.marker}`)

    const blob = await ctx.storage.get(document.storageId)
    if (!blob) throw new Error(`恢复演练文件不存在：${document.storageId}`)

    return {
      ...document,
      contentType: blob.type,
      bytes: await blob.arrayBuffer(),
    }
  },
})
