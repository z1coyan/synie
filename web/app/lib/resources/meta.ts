import type { components } from '../api/schema'
import type { GridActionMeta, GridColumnMeta, GridMeta } from '~/components/synie-data-grid/types'

type ResourceDocument = components['schemas']['ResourceMetaDocument']

export function gridMeta(document: ResourceDocument): GridMeta {
  return {
    columns: document.grid.columns.map((column): GridColumnMeta => ({
      name: column.name,
      type: column.type,
      label: column.label,
      sortable: column.sortable,
      filterable: column.filterable,
      enumOptions: column.enumOptions ?? null,
      ref: column.ref
        ? {
            resource: column.ref.resource ?? null,
            relation: column.ref.relation ?? null,
            labelField: column.ref.labelField ?? null,
            discriminator: column.ref.discriminator ?? null,
            discriminatorType: column.ref.discriminatorType ?? null,
            variants: column.ref.variants ?? null,
          }
        : null,
    })),
    capabilities: document.grid.capabilities,
    extendedActions: document.grid.extendedActions.map((action): GridActionMeta => ({
      key: action.key,
      label: action.label,
      scope: action.scope,
      mutation: action.mutation,
      isDanger: action.isDanger,
      http: action.http,
      confirmKind: action.confirmKind,
    })),
    destroyMutation: document.grid.destroyMutation ?? null,
  }
}
