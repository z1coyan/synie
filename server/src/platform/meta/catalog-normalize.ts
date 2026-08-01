/**
 * Resource Catalog 规范化：ResourceMeta → NormalizedResource → ResourceDocument。
 * contract 后唯一路径（无 legacy normalizer）。
 * 本模块不执行保存、不生成 SQL。
 */
import type {
  BasicFormFieldPlacement,
  BasicFormSection,
  BasicFormTab,
  CommandDocument,
  CommandTarget,
  FieldDocument,
  FieldInputPolicy,
  FilterState,
  FormDocument,
  ListLayoutMeta,
  ResourceDocument,
  ResourceLookupMeta,
} from '@synie/shared'
import { RESOURCE_DOCUMENT_SCHEMA_VERSION } from '@synie/shared'
import type { ActionMeta, FieldMeta, ResourceMeta } from './types.ts'

const STANDARD_CRUD = new Set(['read', 'create', 'update', 'delete'])
const STANDARD_ACTION_KEYS = new Set([
  'read',
  'create',
  'update',
  'delete',
  'print',
  'import',
  'export',
  'batch_delete',
  'batch_update',
  'batch_print',
])

export interface NormalizedResource {
  readonly meta: ResourceMeta
  /** 独立显示标签（可与 permissionLabel 不同） */
  readonly label: string
  readonly fields: FieldDocument[]
  readonly lookup: ResourceLookupMeta
  readonly list: ListLayoutMeta
  readonly form: FormDocument
  /** 领域语义命令（不含标准 CRUD） */
  readonly commands: CommandDocument[]
}

function inputPolicy(field: FieldMeta): FieldInputPolicy {
  if (field.readonly) {
    return { create: 'forbidden', update: 'forbidden' }
  }
  if (field.createOnly) {
    return {
      create: field.required ? 'required' : 'optional',
      update: 'forbidden',
    }
  }
  return {
    create: field.required ? 'required' : 'optional',
    update: 'allowed',
    clearable: !field.required,
  }
}

function toFieldDocument(field: FieldMeta): FieldDocument | null {
  if (field.printOnly) return null
  // sensitive：不进 catalog 可读投影
  if (field.sensitive) return null

  const base = {
    name: field.apiName,
    label: field.label,
    visibility: 'readable' as const,
    input: inputPolicy(field),
    filterable: field.filterable ?? false,
    sortable: field.sortable ?? false,
    ...(field.type === 'string' && (field.filterable ?? false)
      ? { searchable: true as const }
      : {}),
  }

  if (field.ref?.discriminator) {
    return {
      ...base,
      kind: 'polymorphicReference',
      discriminator: field.ref.discriminator,
      discriminatorType: field.ref.discriminatorType ?? 'string',
      variants: (field.ref.variants ?? []).map((v) => ({
        value: v.value,
        resource: v.resource,
        labelField: v.labelField,
        label: v.label,
      })),
    }
  }

  if (field.ref?.resource || field.type === 'fk') {
    return {
      ...base,
      kind: 'reference',
      targetResource: field.ref?.resource ?? '',
      ...(field.ref?.relation ? { relation: field.ref.relation } : {}),
      ...(field.ref?.labelField ? { labelField: field.ref.labelField } : {}),
    }
  }

  switch (field.type) {
    case 'uuid':
      return { ...base, kind: 'uuid' }
    case 'json':
      return { ...base, kind: 'json' }
    case 'enum':
      return {
        ...base,
        kind: 'enum',
        options: field.enumOptions ?? [],
      }
    case 'enumArray':
      return {
        ...base,
        kind: 'enumArray',
        options: field.enumOptions ?? [],
      }
    case 'string':
    case 'integer':
    case 'decimal':
    case 'boolean':
    case 'date':
    case 'datetime':
      return {
        ...base,
        kind: 'scalar',
        scalarType: field.type,
        ...(field.decimalScale !== undefined ? { decimalScale: field.decimalScale } : {}),
      }
    default:
      return {
        ...base,
        kind: 'scalar',
        scalarType: 'string',
      }
  }
}

function defaultLookup(fields: FieldDocument[]): ResourceLookupMeta {
  const names = new Set(fields.map((f) => f.name))
  const labelField = names.has('name')
    ? 'name'
    : names.has('label')
      ? 'label'
      : names.has('code')
        ? 'code'
        : (fields.find((f) => f.kind === 'scalar' && f.scalarType === 'string')?.name ??
          fields[0]?.name ??
          'id')
  const searchFields = fields
    .filter((f) => f.searchable || (f.kind === 'scalar' && f.scalarType === 'string' && f.filterable))
    .map((f) => f.name)
  return {
    labelField,
    searchFields: searchFields.length > 0 ? searchFields : [labelField],
  }
}

function mergeLookup(
  inferred: ResourceLookupMeta,
  override: ResourceMeta['lookup'] | undefined,
): ResourceLookupMeta {
  if (!override) return inferred
  const labelField = override.labelField ?? inferred.labelField
  const searchFields =
    override.searchFields && override.searchFields.length > 0
      ? override.searchFields
      : inferred.searchFields
  const lookup: ResourceLookupMeta = { labelField, searchFields }
  if (override.subtitleFields && override.subtitleFields.length > 0) {
    lookup.subtitleFields = override.subtitleFields
  } else if (inferred.subtitleFields && inferred.subtitleFields.length > 0) {
    lookup.subtitleFields = inferred.subtitleFields
  }
  if (override.defaultSort) {
    lookup.defaultSort = override.defaultSort
  } else if (inferred.defaultSort) {
    lookup.defaultSort = inferred.defaultSort
  }
  return lookup
}

function commandTarget(action: ActionMeta): CommandTarget {
  if (action.commandTarget) return action.commandTarget
  if (action.scope === 'row') return 'row'
  if (action.scope === 'bulk') return 'bulk'
  return 'rowOrBulk'
}

/**
 * v2 命令语义 key：优先 permissionAction 当其与 key 不同且 key 为伪装标准动作时。
 * 例：export+reconcile → reconcile；import+recalc → recalc；setDefault+update → setDefault。
 * contract 后仅投影语义 command key。
 */
function semanticCommandKey(action: ActionMeta): string {
  const pa = action.permissionAction
  if (pa && pa !== action.key && STANDARD_ACTION_KEYS.has(action.key) && !STANDARD_CRUD.has(pa)) {
    return pa
  }
  return action.key
}

function toCommands(meta: ResourceMeta): CommandDocument[] {
  const commands: CommandDocument[] = []
  for (const action of meta.actions) {
    if (STANDARD_CRUD.has(action.key)) continue
    // 标准 print/import/export/batch_* 若无自定义 permissionAction 伪装，暂不进 v2 commands
    // （它们仍贡献 capabilities）；伪装语义动作（reconcile/recalc）进入 commands。
    const key = semanticCommandKey(action)
    const isDisguised = key !== action.key
    const isExtended = !STANDARD_ACTION_KEYS.has(action.key)
    if (!isDisguised && !isExtended) continue

    commands.push({
      key,
      label: action.label,
      target: commandTarget(action),
      requiredCapability: action.permissionAction ?? action.key,
      ...(action.isDanger ? { isDanger: true } : {}),
      ...(action.confirmKind ? { confirmKind: action.confirmKind } : {}),
    })
  }
  return commands
}

/**
 * 将 form.fields 中的静态初值、外键 FilterState 并入 FieldDocument。
 * expand 期允许通过 form 提示补齐 catalog 字段事实，避免页面重复配置。
 */
function applyFormFieldHints(fields: FieldDocument[], meta: ResourceMeta): FieldDocument[] {
  const hints = meta.form?.fields ?? {}
  if (Object.keys(hints).length === 0) return fields

  return fields.map((field) => {
    const hint = hints[field.name]
    if (!hint) return field

    let next = field
    const initial =
      hint.defaultValue !== undefined
        ? hint.defaultValue
        : hint.initial !== undefined
          ? hint.initial
          : undefined
    if (initial !== undefined) {
      next = {
        ...next,
        input: { ...next.input, initial },
      }
    }

    if (next.kind === 'reference') {
      let filterState: unknown = hint.filterState
      if (filterState === undefined && isObject(hint.remote)) {
        filterState = hint.remote.filterState
      }
      if (filterState !== undefined && isObject(filterState)) {
        next = { ...next, filterState: filterState as FilterState }
      }
      if (hint.picker === 'dialog' || hint.picker === 'default') {
        next = { ...next, picker: hint.picker }
      }
    }

    return next
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toForm(meta: ResourceMeta, fields: FieldDocument[]): FormDocument {
  if (!meta.form) return { kind: 'none' }
  if (meta.form.kind === 'extension') return { kind: 'extension' }
  if (meta.form.kind === 'none') return { kind: 'none' }

  const excluded = new Set(meta.form.exclude ?? [])
  const formFieldHints = meta.form.fields ?? {}
  const eligible = fields.filter(
    (field) =>
      !excluded.has(field.name) &&
      (field.input.create !== 'forbidden' || field.input.update !== 'forbidden') &&
      // JSON / polymorphic 留给 extension；basic renderer 不退化为文本
      field.kind !== 'json' &&
      field.kind !== 'polymorphicReference',
  )
  const eligibleNames = new Set(eligible.map((field) => field.name))

  const placementFor = (
    fieldName: string,
    declared: BasicFormFieldPlacement = { field: fieldName },
  ): BasicFormFieldPlacement => {
    const hint = formFieldHints[fieldName]
    const placement: BasicFormFieldPlacement = { ...declared, field: fieldName }
    if (placement.placeholder === undefined && typeof hint?.placeholder === 'string') {
      placement.placeholder = hint.placeholder
    }
    const span =
      placement.span ??
      (typeof hint?.span === 'number'
        ? hint.span
        : typeof hint?.cols === 'number'
          ? hint.cols
          : undefined)
    if (typeof span === 'number' && Number.isFinite(span)) {
      placement.span = Math.min(12, Math.max(1, Math.round(span)))
    }
    return placement
  }

  const sections: BasicFormSection[] | undefined = meta.form.sections?.map((section) => ({
    ...section,
    fields: section.fields
      .filter((placement) => eligibleNames.has(placement.field))
      .map((placement) => placementFor(placement.field, placement)),
  }))
  const tabs: BasicFormTab[] | undefined = meta.form.tabs?.map((tab) => ({
    ...tab,
    fields: tab.fields
      ?.filter((placement) => eligibleNames.has(placement.field))
      .map((placement) => placementFor(placement.field, placement)),
    sections: tab.sections?.map((section) => ({
      ...section,
      fields: section.fields
        .filter((placement) => eligibleNames.has(placement.field))
        .map((placement) => placementFor(placement.field, placement)),
    })),
  }))

  if (sections?.length || tabs?.length) {
    return {
      kind: 'basic',
      layout: {
        ...(sections?.length ? { sections } : {}),
        ...(tabs?.length ? { tabs } : {}),
      },
    }
  }

  const placements = eligible
    .map((field, sourceIndex) => ({
      placement: placementFor(field.name),
      order: formFieldHints[field.name]?.order ?? sourceIndex,
      sourceIndex,
    }))
    .sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex)
    .map(({ placement }) => placement)

  if (placements.length === 0) return { kind: 'none' }
  return { kind: 'basic', layout: { fields: placements } }
}

function assertBasicFormDoesNotRepeatFieldFacts(meta: ResourceMeta): void {
  if (meta.form?.kind !== 'basic') return
  for (const [fieldName, hint] of Object.entries(meta.form.fields ?? {})) {
    const repeated = [
      hint.required !== undefined ? 'required' : null,
      hint.edit !== undefined ? 'edit' : null,
      hint.label !== undefined ? 'label' : null,
    ].filter((name): name is string => name !== null)
    if (repeated.length > 0) {
      throw new Error(
        `资源「${meta.name}」basic form 字段「${fieldName}」重复字段事实: ${repeated.join(', ')}`,
      )
    }
  }
}

/**
 * 将 ResourceMeta 规范为 Catalog 中间事实。
 */
export function buildNormalizedResource(meta: ResourceMeta): NormalizedResource {
  assertBasicFormDoesNotRepeatFieldFacts(meta)
  const fields: FieldDocument[] = []
  for (const field of meta.fields) {
    const doc = toFieldDocument(field)
    if (doc) fields.push(doc)
  }
  const withHints = applyFormFieldHints(fields, meta)
  const list: ListLayoutMeta = {
    columns: withHints.filter((f) => f.visibility === 'readable').map((f) => f.name),
  }
  return {
    meta,
    label: meta.label ?? meta.permissionLabel,
    fields: withHints,
    lookup: mergeLookup(defaultLookup(withHints), meta.lookup),
    list,
    form: toForm(meta, withHints),
    commands: toCommands(meta),
  }
}

/** 按 Actor 能力裁剪 NormalizedResource 为完整 ResourceDocument */
export function projectResourceDocument(
  normalized: NormalizedResource,
  capabilities: string[],
  refAvailability: (field: FieldDocument) => FieldDocument,
): ResourceDocument {
  const fields = normalized.fields.map(refAvailability)
  return {
    schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
    name: normalized.meta.name,
    label: normalized.label,
    permissionPrefix: normalized.meta.permissionPrefix,
    capabilities: [...capabilities],
    fields,
    lookup: normalized.lookup,
    list: {
      columns: normalized.list.columns.filter((name) => {
        const field = fields.find((f) => f.name === name)
        return field?.visibility === 'readable'
      }),
    },
    form: projectFormForActor(normalized.form, fields),
    commands: normalized.commands.filter((c) => capabilities.includes(c.requiredCapability)),
  }
}

/**
 * Actor 无目标读取权时：reference 标记 targetUnavailable；
 * Basic Form 布局移除该字段（不产生可编辑原始 ID）。
 */
function projectFormForActor(form: FormDocument, fields: FieldDocument[]): FormDocument {
  if (form.kind !== 'basic') return form
  const unavailable = new Set(
    fields
      .filter(
        (f) =>
          (f.kind === 'reference' || f.kind === 'polymorphicReference') && f.targetUnavailable,
      )
      .map((f) => f.name),
  )
  if (unavailable.size === 0) return form

  const filterPlacements = (items: BasicFormFieldPlacement[] | undefined) =>
    items?.filter((p) => !unavailable.has(p.field))

  return {
    kind: 'basic',
    layout: {
      fields: filterPlacements(form.layout.fields),
      sections: form.layout.sections?.map((s) => ({
        ...s,
        fields: filterPlacements(s.fields) ?? [],
      })),
      tabs: form.layout.tabs?.map((t) => ({
        ...t,
        fields: filterPlacements(t.fields),
        sections: t.sections?.map((s) => ({
          ...s,
          fields: filterPlacements(s.fields) ?? [],
        })),
      })),
    },
  }
}
