/**
 * SQL 标识符白名单：仅允许小写 snake_case 表/列名进入 sql.raw。
 * 任何动态表名（如骨架 spec.headTable）必须经此函数，禁止直接拼字符串。
 */
import { sql, type RawBuilder } from 'kysely'

export function ident(name: string): RawBuilder<unknown> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`非法 SQL 标识符: ${name}`)
  }
  return sql.raw(name)
}
