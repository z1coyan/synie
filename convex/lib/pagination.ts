import type { PaginationResult } from 'convex/server'
import { MAX_RESOURCE_PAGE_SIZE } from '@synie/shared'
import { synieError } from './errors'

export { MAX_RESOURCE_PAGE_SIZE } from '@synie/shared'

export function paginationOptions(input: {
  numItems: number
  cursor?: string | null
}): { numItems: number; cursor: string | null } {
  if (
    !Number.isInteger(input.numItems) ||
    input.numItems < 1 ||
    input.numItems > MAX_RESOURCE_PAGE_SIZE
  ) {
    throw synieError('validation', `每页条数必须是 1..${MAX_RESOURCE_PAGE_SIZE} 的整数`)
  }
  return { numItems: input.numItems, cursor: input.cursor ?? null }
}

export function resourcePage<T>(page: PaginationResult<T>) {
  return {
    results: page.page,
    pageInfo: {
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    },
  }
}

export function requireSearchTerm(value: string | undefined): string {
  const search = value?.trim()
  if (!search) throw synieError('validation', 'search profile 需要非空搜索词')
  if ([...search].length > 128) throw synieError('validation', '搜索词不能超过 128 个字符')
  return search
}

export function rejectSearch(value: string | undefined): void {
  if (value !== undefined) throw synieError('validation', '当前 query profile 不接受搜索词')
}
