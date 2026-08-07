/**
 * 枚举库内大小写规范化的唯一入口。
 *
 * wire 恒为大写 token；库内缺省小写（全站约定），历史遗留大写列
 * （`inv_material.material_type` 带 CHECK 大写白名单）经 `FieldMeta.enumStorage = 'upper'` 声明。
 *
 * 写路径（standard/fields.toDbValue）与查询路径（db/filterbuild 筛选编译）必须
 * 经同一函数换算——两路各自手写 toLowerCase/toUpperCase 曾导致「写入大写、筛选小写」
 * 的 material_type 筛选全空事故。新增大写存储列时只需声明 enumStorage，两路自动一致。
 */
import type { FieldMeta } from './types.ts'

export type EnumStorage = NonNullable<FieldMeta['enumStorage']>

/** wire 枚举值（大写 token）→ 库内存储值 */
export function enumDbValue(storage: EnumStorage | undefined, wireValue: string): string {
  return storage === 'upper' ? wireValue.toUpperCase() : wireValue.toLowerCase()
}
