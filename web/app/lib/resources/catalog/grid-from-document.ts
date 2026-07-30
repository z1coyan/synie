/**
 * 从 ResourceDocument v2 派生 GridMeta。
 * contract 后这是 Grid 唯一 Meta 来源。
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

  // list 为空时回退到全部 readable 字段
  const resolvedColumns =
    columns.length > 0
      ? columns
      : document.fields.filter((f) => f.visibility === 'readable').map(fieldToColumn)

  return {
    columns: resolvedColumns,
    capabilities: [...document.capabilities],
    extendedActions: document.commands.map((c) => ({
      key: c.key,
      label: c.label,
      // collection 命令通常挂工具栏；row/bulk/rowOrBulk 进行菜单与批量条
      scope:
        c.target === 'collection'
          ? ('both' as const)
          : c.target === 'row'
            ? ('row' as const)
            : c.target === 'bulk'
              ? ('bulk' as const)
              : ('both' as const),
      requiredCapability: c.requiredCapability,
      target: c.target,
      isDanger: c.isDanger ?? false,
      confirmKind: c.confirmKind,
    })),
    canDelete: document.capabilities.includes('delete'),
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
            discriminatorType: field.discriminatorType ?? 'enum',
            variants: field.variants.map((v) => ({
              value: v.value,
              resource: v.resource,
              labelField: v.labelField,
              label: v.label,
            })),
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
  // scalar
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
