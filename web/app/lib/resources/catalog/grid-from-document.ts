/**
 * 从 ResourceDocument v2 派生 GridMeta（expand 期 Grid 消费 catalog 的桥）。
 * 与 v1 document.grid 语义对齐，供 binding.meta() 使用。
 */
import type { ResourceDocument } from '@synie/shared'
import type { GridColumnMeta, GridMeta } from '~/components/synie-data-grid/types'

export function gridMetaFromDocument(document: ResourceDocument): GridMeta {
  const byName = new Map(document.fields.map((f) => [f.name, f]))
  const columns: GridColumnMeta[] = document.list.columns.map((name) => {
    const field = byName.get(name)
    if (!field) {
      throw new Error(`ResourceDocument ${document.name} list 引用未知字段 ${name}`)
    }
    return fieldToColumn(field)
  })

  // list 未列出但 fields 中存在的列（兼容 v1 全列 Grid）
  if (columns.length === 0) {
    for (const field of document.fields) {
      if (field.visibility === 'readable') columns.push(fieldToColumn(field))
    }
  } else {
    // 补全未在 list 中但 v1 会展示的字段（expand：与 v1 grid 对齐用全 fields）
    // 实际 expand 期 resourceClient.meta 仍可读服务端 grid；本函数用于 catalog 优先路径
  }

  return {
    columns:
      columns.length > 0
        ? columns
        : document.fields.filter((f) => f.visibility === 'readable').map(fieldToColumn),
    capabilities: [...document.capabilities],
    extendedActions: document.commands.map((c) => ({
      key: c.key,
      label: c.label,
      scope:
        c.target === 'collection'
          ? ('both' as const)
          : c.target === 'row'
            ? ('row' as const)
            : c.target === 'bulk'
              ? ('bulk' as const)
              : ('both' as const),
      mutation: '',
      isDanger: c.isDanger ?? false,
      confirmKind: c.confirmKind,
    })),
    destroyMutation: null,
  }
}

function fieldToColumn(field: ResourceDocument['fields'][number]): GridColumnMeta {
  if (field.kind === 'reference') {
    return {
      name: field.name,
      type: field.targetUnavailable ? 'string' : 'fk',
      label: field.label,
      sortable: field.sortable,
      filterable: field.targetUnavailable ? false : field.filterable,
      enumOptions: null,
      ref: field.targetUnavailable
        ? null
        : {
            resource: field.targetResource,
            relation: field.relation ?? null,
            labelField: field.labelField ?? null,
            discriminator: null,
            discriminatorType: null,
            variants: null,
          },
    }
  }
  if (field.kind === 'polymorphicReference') {
    return {
      name: field.name,
      type: field.targetUnavailable ? 'string' : 'fk',
      label: field.label,
      sortable: field.sortable,
      filterable: field.targetUnavailable ? false : field.filterable,
      enumOptions: null,
      ref: field.targetUnavailable
        ? null
        : {
            resource: null,
            relation: null,
            labelField: null,
            discriminator: field.discriminator,
            discriminatorType: field.discriminatorType,
            variants: field.variants,
          },
    }
  }
  if (field.kind === 'enum' || field.kind === 'enumArray') {
    return {
      name: field.name,
      type: field.kind,
      label: field.label,
      sortable: field.sortable,
      filterable: field.filterable,
      enumOptions: field.options,
      ref: null,
    }
  }
  if (field.kind === 'uuid') {
    return {
      name: field.name,
      type: 'string',
      label: field.label,
      sortable: field.sortable,
      filterable: field.filterable,
      enumOptions: null,
      ref: null,
    }
  }
  if (field.kind === 'json') {
    return {
      name: field.name,
      type: 'string',
      label: field.label,
      sortable: false,
      filterable: false,
      enumOptions: null,
      ref: null,
    }
  }
  return {
    name: field.name,
    type: field.scalarType,
    label: field.label,
    sortable: field.sortable,
    filterable: field.filterable,
    enumOptions: null,
    ref: null,
  }
}
