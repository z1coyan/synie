/**
 * ResourceReadSpec：动态筛选/排序/搜索的最小不可变白名单。
 * 不含 SQL source、select、join、公司范围或默认排序——那些仍由领域查询拥有。
 */
import type { FieldMeta, FieldType, ResourceMeta } from './types.ts'

export interface ResourceReadFieldSpec {
  apiName: string
  dbColumn: string
  type: FieldType
  filterable: boolean
  sortable: boolean
  /** 自由搜索仅使用 searchable 字符串字段 */
  searchable: boolean
  /** wire 枚举值（大写 token）；仅 enum / enumArray */
  enumValues?: readonly string[]
  /** 多态外键：判别字段 apiName */
  discriminatorApiName?: string
  /** 多态外键：允许的变体 value */
  polyVariants?: readonly string[]
}

export interface ResourceReadSpec {
  readonly name: string
  readonly fields: readonly ResourceReadFieldSpec[]
}

/** 从 ResourceMeta / sealed Catalog 派生不可变 ReadSpec */
export function toReadSpec(resource: ResourceMeta): ResourceReadSpec {
  const fields: ResourceReadFieldSpec[] = resource.fields
    .filter((f) => !f.printOnly && !f.sensitive)
    .map((f) => fieldToReadSpec(f))
  return Object.freeze({
    name: resource.name,
    fields: Object.freeze(fields.map((f) => Object.freeze(f))),
  })
}

function fieldToReadSpec(field: FieldMeta): ResourceReadFieldSpec {
  const spec: ResourceReadFieldSpec = {
    apiName: field.apiName,
    dbColumn: field.dbColumn,
    type: field.type,
    filterable: field.filterable ?? false,
    sortable: field.sortable ?? false,
    searchable: (field.filterable ?? false) && field.type === 'string',
  }
  if (field.enumOptions && field.enumOptions.length > 0) {
    spec.enumValues = field.enumOptions.map((o) => o.value)
  }
  if (field.ref?.discriminator) {
    spec.discriminatorApiName = field.ref.discriminator
    spec.polyVariants = (field.ref.variants ?? []).map((v) => v.value)
  }
  return spec
}
