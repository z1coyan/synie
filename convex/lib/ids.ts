import type { Id, TableNames } from '../_generated/dataModel'

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

/** Runtime shape only; table membership/existence must still be checked with ctx.db.get. */
export function asOpaqueId<TableName extends TableNames>(
  value: string,
  _table: TableName,
): Id<TableName> {
  if (!isOpaqueId(value)) throw new TypeError('id 必须是非空 opaque string')
  return value as Id<TableName>
}
