/**
 * Actor 隔离的 ResourceDocument 缓存。
 * 切换会话时必须 clearCatalogCache，防止能力与外键可见性泄漏。
 */
import type { ResourceDocument } from '@synie/shared'

type CacheKey = string

const documents = new Map<CacheKey, ResourceDocument>()
let actorKey: string | null = null

function cacheKey(resource: string): CacheKey {
  return `${actorKey ?? 'anon'}::${resource}`
}

/** 绑定当前 Actor 缓存命名空间（建议用 userId） */
export function setCatalogActor(userId: string | null): void {
  if (actorKey === userId) return
  documents.clear()
  actorKey = userId
}

export function getCatalogActor(): string | null {
  return actorKey
}

export function getCachedDocument(resource: string): ResourceDocument | undefined {
  return documents.get(cacheKey(resource))
}

export function setCachedDocument(resource: string, document: ResourceDocument): void {
  documents.set(cacheKey(resource), document)
}

/** 会话切换 / 登出时清空全部 actor 相关 Meta */
export function clearCatalogCache(): void {
  documents.clear()
  actorKey = null
}

/** 测试用：当前缓存条目数 */
export function catalogCacheSize(): number {
  return documents.size
}
