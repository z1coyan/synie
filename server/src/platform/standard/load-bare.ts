/**
 * 标准动作内核·裸表锁读（内部共享）：loadAuthorized + 物理字段 wire 映射。
 *
 * FOR UPDATE 不能走投影子查询，故写前锁一律裸表。root 写路径（service.loadBare）
 * 与聚合头写前锁（aggregate.lockHead）共用本唯一拷贝。
 */
import type { RawBuilder } from 'kysely'
import { loadAuthorized } from '~/db/load.ts'
import type { DbHandle } from '~/db/tx.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import type { AuthzTarget } from '~/platform/meta/resource-authz.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'
import { mapRow } from './fields.ts'

export async function loadBareAuthorized<TItem>(options: {
  handle: DbHandle
  permit: Permit
  target: AuthzTarget
  meta: ResourceMeta
  id: string
  /** 行锁：写路径（更新/删除/转移）置 true */
  forUpdate: boolean
  notFoundMessage: string
  /** 领域附加行筛选（与 loadAuthorized.extraWhere 同语义） */
  extraWhere?: RawBuilder<unknown> | null
}): Promise<TItem> {
  const row = await loadAuthorized({
    db: options.handle,
    permit: options.permit,
    target: options.target,
    table: options.meta.table,
    id: options.id,
    forUpdate: options.forUpdate,
    notFoundMessage: options.notFoundMessage,
    extraWhere: options.extraWhere ?? null,
  })
  return mapRow(options.meta, row as Record<string, unknown>) as TItem
}
