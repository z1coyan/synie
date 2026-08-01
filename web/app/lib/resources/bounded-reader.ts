import { MAX_RESOURCE_PAGE_SIZE } from '@synie/shared'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceReader } from './catalog'
import type { ResourceQuery } from './types'

/**
 * 在调用方给定的总上限内沿 opaque cursor 拉取资源行。
 *
 * ResourceReader 的单页上限属于 transport contract；调用方需要超过一页时不能
 * 放大 numItems，只能保留原查询并逐页跟随后端返回的 cursor。
 */
export async function readResourceRowsBounded(
  reader: Pick<ResourceReader, 'query'>,
  query: Omit<ResourceQuery, 'numItems' | 'cursor'>,
  limit: number,
): Promise<Row[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('资源行总拉取上限必须是正整数')
  }

  const rows: Row[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

  while (rows.length < limit) {
    const page = await reader.query({
      ...query,
      numItems: Math.min(MAX_RESOURCE_PAGE_SIZE, limit - rows.length),
      cursor,
    })
    rows.push(...page.results.slice(0, limit - rows.length))

    if (page.pageInfo.isDone || rows.length >= limit) {
      return rows
    }

    const next = page.pageInfo.continueCursor
    if (!next) throw new Error('分页未结束但缺少 continueCursor')
    if (seenCursors.has(next)) throw new Error('分页 cursor 重复，已中止加载')
    seenCursors.add(next)
    cursor = next
  }

  return rows
}

/**
 * 对多个父记录逐个建立单值 FK 查询，并在所有父记录之间共享总拉取上限。
 * 每个父记录都从 null cursor 开始，避免把多值父范围传给 single-parent profile。
 */
export async function readResourceRowsForParentsBounded(
  reader: Pick<ResourceReader, 'query'>,
  query: Omit<ResourceQuery, 'numItems' | 'cursor'>,
  parentField: string,
  parentIds: readonly string[],
  limit: number,
): Promise<Row[]> {
  const rows: Row[] = []
  for (const parentId of parentIds) {
    if (rows.length >= limit) break
    rows.push(
      ...(await readResourceRowsBounded(
        reader,
        {
          ...query,
          fixedFilter: {
            ...query.fixedFilter,
            [parentField]: {
              kind: 'fk',
              op: 'in',
              values: [parentId],
              labels: [],
            },
          },
        },
        limit - rows.length,
      )),
    )
  }
  return rows
}
