/**
 * ResourceDocument v3 运行时 decoder：拒绝未知 schema、非法 kind、断裂布局与非法 target。
 * 无 zod 依赖：手写 fail-closed 校验，供 shared/server/web 共用。
 */
import type { FilterState, SortState } from './filter.ts'
import type { DataScope } from './meta.ts'
import {
  RESOURCE_DOCUMENT_SCHEMA_VERSION,
  type BasicFormFieldPlacement,
  type BasicFormLayout,
  type BasicFormSection,
  type BasicFormTab,
  type CapabilityEntry,
  type CommandDocument,
  type CommandTarget,
  type FieldDocument,
  type FieldInputPolicy,
  type FormDocument,
  type FormShowIn,
  type ListLayoutMeta,
  type PolymorphicReferenceVariant,
  type ResourceDocument,
  type ResourceDocumentAuthz,
  type ResourceLookupMeta,
  type ScalarFieldType,
} from './resource-document.ts'

export class ResourceDocumentDecodeError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ResourceDocumentDecodeError'
    this.path = path
  }
}

const SCALAR_TYPES = new Set<ScalarFieldType>([
  'string',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
])
const FIELD_KINDS = new Set([
  'scalar',
  'uuid',
  'json',
  'enum',
  'enumArray',
  'reference',
  'polymorphicReference',
])
const CREATE_POLICIES = new Set(['required', 'optional', 'forbidden'])
const UPDATE_POLICIES = new Set(['allowed', 'forbidden'])
const VISIBILITIES = new Set(['readable', 'writeOnly'])
const COMMAND_TARGETS = new Set<CommandTarget>(['collection', 'row', 'bulk', 'rowOrBulk'])
const FORM_KINDS = new Set(['none', 'extension', 'basic'])
const SHOW_IN = new Set<FormShowIn>(['create', 'edit', 'view'])
const PICKERS = new Set(['default', 'dialog'])
const CONFIRM_KINDS = new Set(['none', 'generic', 'audit_doc'])
const DATA_SCOPES = new Set<DataScope>(['all', 'deptTree', 'dept', 'self'])
const DEPT_MODES = new Set(['stamped', 'assigned'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new ResourceDocumentDecodeError(path, message)
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, '须为非空字符串')
  }
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '须为 boolean')
  return value
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, '须为字符串数组')
  return value.map((item, i) => asString(item, `${path}[${i}]`))
}

function decodeInputPolicy(raw: unknown, path: string): FieldInputPolicy {
  if (!isObject(raw)) fail(path, '须为对象')
  const create = asString(raw.create, `${path}.create`)
  const update = asString(raw.update, `${path}.update`)
  if (!CREATE_POLICIES.has(create)) fail(`${path}.create`, `非法策略: ${create}`)
  if (!UPDATE_POLICIES.has(update)) fail(`${path}.update`, `非法策略: ${update}`)
  const policy: FieldInputPolicy = {
    create: create as FieldInputPolicy['create'],
    update: update as FieldInputPolicy['update'],
  }
  if (raw.clearable !== undefined) {
    policy.clearable = asBoolean(raw.clearable, `${path}.clearable`)
  }
  if ('initial' in raw) {
    policy.initial = raw.initial
  }
  return policy
}

function decodeEnumOptions(raw: unknown, path: string): { value: string; label: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(path, '须为非空枚举选项数组')
  return raw.map((item, i) => {
    const p = `${path}[${i}]`
    if (!isObject(item)) fail(p, '须为对象')
    return {
      value: asString(item.value, `${p}.value`),
      label: asString(item.label, `${p}.label`),
    }
  })
}

function decodeFieldBase(raw: Record<string, unknown>, path: string) {
  const visibility = asString(raw.visibility, `${path}.visibility`)
  if (!VISIBILITIES.has(visibility)) fail(`${path}.visibility`, `非法可见性: ${visibility}`)
  const base = {
    name: asString(raw.name, `${path}.name`),
    label: asString(raw.label, `${path}.label`),
    visibility: visibility as FieldDocument['visibility'],
    input: decodeInputPolicy(raw.input, `${path}.input`),
    filterable: asBoolean(raw.filterable, `${path}.filterable`),
    sortable: asBoolean(raw.sortable, `${path}.sortable`),
  }
  if (raw.searchable !== undefined) {
    return { ...base, searchable: asBoolean(raw.searchable, `${path}.searchable`) }
  }
  return base
}

function decodeField(raw: unknown, path: string): FieldDocument {
  if (!isObject(raw)) fail(path, '须为对象')
  const kind = asString(raw.kind, `${path}.kind`)
  if (!FIELD_KINDS.has(kind)) fail(`${path}.kind`, `未知字段 kind: ${kind}`)
  const base = decodeFieldBase(raw, path)

  switch (kind) {
    case 'scalar': {
      const scalarType = asString(raw.scalarType, `${path}.scalarType`) as ScalarFieldType
      if (!SCALAR_TYPES.has(scalarType)) {
        fail(`${path}.scalarType`, `非法 scalarType: ${scalarType}`)
      }
      const field: FieldDocument = { ...base, kind: 'scalar', scalarType }
      if (raw.decimalScale !== undefined) {
        if (typeof raw.decimalScale !== 'number' || !Number.isInteger(raw.decimalScale)) {
          fail(`${path}.decimalScale`, '须为整数')
        }
        field.decimalScale = raw.decimalScale
      }
      return field
    }
    case 'uuid':
      return { ...base, kind: 'uuid' }
    case 'json':
      return { ...base, kind: 'json' }
    case 'enum':
      return { ...base, kind: 'enum', options: decodeEnumOptions(raw.options, `${path}.options`) }
    case 'enumArray':
      return {
        ...base,
        kind: 'enumArray',
        options: decodeEnumOptions(raw.options, `${path}.options`),
      }
    case 'reference': {
      const field: FieldDocument = {
        ...base,
        kind: 'reference',
        targetResource: asString(raw.targetResource, `${path}.targetResource`),
      }
      if (raw.relation !== undefined) {
        field.relation = asString(raw.relation, `${path}.relation`)
      }
      if (raw.labelField !== undefined) {
        field.labelField = asString(raw.labelField, `${path}.labelField`)
      }
      if (raw.picker !== undefined) {
        const picker = asString(raw.picker, `${path}.picker`)
        if (!PICKERS.has(picker)) fail(`${path}.picker`, `非法 picker: ${picker}`)
        field.picker = picker as 'default' | 'dialog'
      }
      if (raw.filterState !== undefined) {
        if (!isObject(raw.filterState)) fail(`${path}.filterState`, '须为 FilterState 对象')
        field.filterState = raw.filterState as FilterState
      }
      if (raw.targetUnavailable !== undefined) {
        field.targetUnavailable = asBoolean(raw.targetUnavailable, `${path}.targetUnavailable`)
      }
      return field
    }
    case 'polymorphicReference': {
      if (!Array.isArray(raw.variants)) fail(`${path}.variants`, '须为数组')
      const discType = asString(raw.discriminatorType, `${path}.discriminatorType`)
      if (discType !== 'enum' && discType !== 'string') {
        fail(`${path}.discriminatorType`, `非法类型: ${discType}`)
      }
      const variants: PolymorphicReferenceVariant[] = raw.variants.map((item, i) => {
        const p = `${path}.variants[${i}]`
        if (!isObject(item)) fail(p, '须为对象')
        return {
          value: asString(item.value, `${p}.value`),
          resource: asString(item.resource, `${p}.resource`),
          labelField: asString(item.labelField, `${p}.labelField`),
          label: asString(item.label, `${p}.label`),
        }
      })
      const field: FieldDocument = {
        ...base,
        kind: 'polymorphicReference',
        discriminator: asString(raw.discriminator, `${path}.discriminator`),
        discriminatorType: discType,
        variants,
      }
      if (raw.targetUnavailable !== undefined) {
        field.targetUnavailable = asBoolean(raw.targetUnavailable, `${path}.targetUnavailable`)
      }
      return field
    }
    default:
      fail(`${path}.kind`, `未知字段 kind: ${kind}`)
  }
}

function decodeLookup(raw: unknown, path: string): ResourceLookupMeta {
  if (!isObject(raw)) fail(path, '须为对象')
  const lookup: ResourceLookupMeta = {
    labelField: asString(raw.labelField, `${path}.labelField`),
    searchFields: asStringArray(raw.searchFields, `${path}.searchFields`),
  }
  if (raw.subtitleFields !== undefined) {
    lookup.subtitleFields = asStringArray(raw.subtitleFields, `${path}.subtitleFields`)
  }
  if (raw.defaultSort !== undefined) {
    if (!isObject(raw.defaultSort)) fail(`${path}.defaultSort`, '须为 SortState')
    const column = asString(raw.defaultSort.column, `${path}.defaultSort.column`)
    const direction = asString(raw.defaultSort.direction, `${path}.defaultSort.direction`)
    if (direction !== 'ascending' && direction !== 'descending') {
      fail(`${path}.defaultSort.direction`, `非法方向: ${direction}`)
    }
    lookup.defaultSort = { column, direction } satisfies SortState
  }
  return lookup
}

function decodeList(raw: unknown, path: string): ListLayoutMeta {
  if (!isObject(raw)) fail(path, '须为对象')
  return { columns: asStringArray(raw.columns, `${path}.columns`) }
}

function decodePlacement(raw: unknown, path: string): BasicFormFieldPlacement {
  if (!isObject(raw)) fail(path, '须为对象')
  const placement: BasicFormFieldPlacement = {
    field: asString(raw.field, `${path}.field`),
  }
  if (raw.span !== undefined) {
    if (typeof raw.span !== 'number' || !Number.isInteger(raw.span) || raw.span < 1) {
      fail(`${path}.span`, '须为正整数')
    }
    placement.span = raw.span
  }
  if (raw.placeholder !== undefined) {
    placement.placeholder = asString(raw.placeholder, `${path}.placeholder`)
  }
  if (raw.showIn !== undefined) {
    if (!Array.isArray(raw.showIn)) fail(`${path}.showIn`, '须为数组')
    placement.showIn = raw.showIn.map((item, i) => {
      const v = asString(item, `${path}.showIn[${i}]`)
      if (!SHOW_IN.has(v as FormShowIn)) fail(`${path}.showIn[${i}]`, `非法 showIn: ${v}`)
      return v as FormShowIn
    })
  }
  return placement
}

function decodeSection(raw: unknown, path: string): BasicFormSection {
  if (!isObject(raw)) fail(path, '须为对象')
  if (!Array.isArray(raw.fields)) fail(`${path}.fields`, '须为数组')
  return {
    key: asString(raw.key, `${path}.key`),
    label: asString(raw.label, `${path}.label`),
    fields: raw.fields.map((f, i) => decodePlacement(f, `${path}.fields[${i}]`)),
  }
}

function decodeTab(raw: unknown, path: string): BasicFormTab {
  if (!isObject(raw)) fail(path, '须为对象')
  const tab: BasicFormTab = {
    key: asString(raw.key, `${path}.key`),
    label: asString(raw.label, `${path}.label`),
  }
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) fail(`${path}.sections`, '须为数组')
    tab.sections = raw.sections.map((s, i) => decodeSection(s, `${path}.sections[${i}]`))
  }
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) fail(`${path}.fields`, '须为数组')
    tab.fields = raw.fields.map((f, i) => decodePlacement(f, `${path}.fields[${i}]`))
  }
  return tab
}

function decodeBasicLayout(raw: unknown, path: string): BasicFormLayout {
  if (!isObject(raw)) fail(path, '须为对象')
  const layout: BasicFormLayout = {}
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) fail(`${path}.fields`, '须为数组')
    layout.fields = raw.fields.map((f, i) => decodePlacement(f, `${path}.fields[${i}]`))
  }
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) fail(`${path}.sections`, '须为数组')
    layout.sections = raw.sections.map((s, i) => decodeSection(s, `${path}.sections[${i}]`))
  }
  if (raw.tabs !== undefined) {
    if (!Array.isArray(raw.tabs)) fail(`${path}.tabs`, '须为数组')
    layout.tabs = raw.tabs.map((t, i) => decodeTab(t, `${path}.tabs[${i}]`))
  }
  return layout
}

function collectLayoutFieldNames(layout: BasicFormLayout): string[] {
  const names: string[] = []
  const take = (placements: BasicFormFieldPlacement[] | undefined) => {
    if (!placements) return
    for (const p of placements) names.push(p.field)
  }
  take(layout.fields)
  for (const section of layout.sections ?? []) take(section.fields)
  for (const tab of layout.tabs ?? []) {
    take(tab.fields)
    for (const section of tab.sections ?? []) take(section.fields)
  }
  return names
}

function decodeForm(raw: unknown, path: string, fieldNames: Set<string>): FormDocument {
  if (!isObject(raw)) fail(path, '须为对象')
  const kind = asString(raw.kind, `${path}.kind`)
  if (!FORM_KINDS.has(kind)) fail(`${path}.kind`, `非法 form kind: ${kind}`)
  if (kind === 'none') return { kind: 'none' }
  if (kind === 'extension') return { kind: 'extension' }

  const layout = decodeBasicLayout(raw.layout, `${path}.layout`)
  const placed = collectLayoutFieldNames(layout)
  const seen = new Set<string>()
  for (const name of placed) {
    if (!fieldNames.has(name)) {
      fail(`${path}.layout`, `布局引用未知字段: ${name}`)
    }
    if (seen.has(name)) {
      fail(`${path}.layout`, `布局重复引用字段: ${name}`)
    }
    seen.add(name)
  }
  // create-required 字段必须出现在 create 布局（无 showIn 视为全模式）
  return { kind: 'basic', layout }
}

function decodeCommand(raw: unknown, path: string): CommandDocument {
  if (!isObject(raw)) fail(path, '须为对象')
  const target = asString(raw.target, `${path}.target`) as CommandTarget
  if (!COMMAND_TARGETS.has(target)) fail(`${path}.target`, `非法 command target: ${target}`)

  // 文档不得携带 transport 细节
  for (const banned of ['http', 'path', 'method', 'mutation'] as const) {
    if (banned in raw) fail(path, `command 不得包含 transport 字段: ${banned}`)
  }

  const cmd: CommandDocument = {
    key: asString(raw.key, `${path}.key`),
    label: asString(raw.label, `${path}.label`),
    target,
    requiredCapability: asString(raw.requiredCapability, `${path}.requiredCapability`),
  }
  if (raw.isDanger !== undefined) {
    cmd.isDanger = asBoolean(raw.isDanger, `${path}.isDanger`)
  }
  if (raw.confirmKind !== undefined) {
    const ck = asString(raw.confirmKind, `${path}.confirmKind`)
    if (!CONFIRM_KINDS.has(ck)) fail(`${path}.confirmKind`, `非法 confirmKind: ${ck}`)
    cmd.confirmKind = ck as CommandDocument['confirmKind']
  }
  return cmd
}

function decodeCapabilities(raw: unknown, path: string): CapabilityEntry[] {
  if (!Array.isArray(raw)) fail(path, '须为能力项数组')
  const seen = new Set<string>()
  return raw.map((item, i) => {
    const p = `${path}[${i}]`
    if (!isObject(item)) fail(p, '须为对象')
    const action = asString(item.action, `${p}.action`)
    if (seen.has(action)) fail(`${p}.action`, `能力动作重复: ${action}`)
    seen.add(action)
    const scope = asString(item.scope, `${p}.scope`)
    if (!DATA_SCOPES.has(scope as DataScope)) fail(`${p}.scope`, `非法数据范围: ${scope}`)
    return { action, scope: scope as DataScope }
  })
}

function decodeAuthz(raw: unknown, path: string): ResourceDocumentAuthz {
  if (!isObject(raw)) fail(path, '须为对象')
  const authz: ResourceDocumentAuthz = {}
  if (raw.ownerId !== undefined) {
    authz.ownerId = asString(raw.ownerId, `${path}.ownerId`)
  }
  if (raw.deptId !== undefined) {
    authz.deptId = asString(raw.deptId, `${path}.deptId`)
  }
  if (raw.deptMode !== undefined) {
    const mode = asString(raw.deptMode, `${path}.deptMode`)
    if (!DEPT_MODES.has(mode)) fail(`${path}.deptMode`, `非法部门形态: ${mode}`)
    authz.deptMode = mode as ResourceDocumentAuthz['deptMode']
  }
  if (!authz.ownerId && !authz.deptId) {
    fail(path, '至少声明 ownerId 或 deptId 一个维度')
  }
  return authz
}

/** 解码并校验完整 ResourceDocument v3 */
export function decodeResourceDocument(raw: unknown): ResourceDocument {
  if (!isObject(raw)) fail('$', '须为对象')

  const schemaVersion = raw.schemaVersion
  if (schemaVersion !== RESOURCE_DOCUMENT_SCHEMA_VERSION) {
    fail(
      '$.schemaVersion',
      `不支持的 schema version: ${String(schemaVersion)}（仅支持 ${RESOURCE_DOCUMENT_SCHEMA_VERSION}）`,
    )
  }

  if (!Array.isArray(raw.fields)) fail('$.fields', '须为数组')
  if (!Array.isArray(raw.capabilities)) fail('$.capabilities', '须为数组')
  if (!Array.isArray(raw.commands)) fail('$.commands', '须为数组')

  const fields = raw.fields.map((f, i) => decodeField(f, `$.fields[${i}]`))
  const fieldNames = new Set(fields.map((f) => f.name))
  if (fieldNames.size !== fields.length) {
    fail('$.fields', '字段 name 重复')
  }

  const list = decodeList(raw.list, '$.list')
  for (const col of list.columns) {
    if (!fieldNames.has(col)) fail('$.list.columns', `列表引用未知字段: ${col}`)
  }

  const lookup = decodeLookup(raw.lookup, '$.lookup')
  if (!fieldNames.has(lookup.labelField)) {
    fail('$.lookup.labelField', `引用未知字段: ${lookup.labelField}`)
  }
  for (const sf of lookup.searchFields) {
    if (!fieldNames.has(sf)) fail('$.lookup.searchFields', `引用未知字段: ${sf}`)
  }
  for (const sf of lookup.subtitleFields ?? []) {
    if (!fieldNames.has(sf)) fail('$.lookup.subtitleFields', `引用未知字段: ${sf}`)
  }
  if (lookup.defaultSort && !fieldNames.has(lookup.defaultSort.column)) {
    fail('$.lookup.defaultSort.column', `引用未知字段: ${lookup.defaultSort.column}`)
  }

  const form = decodeForm(raw.form, '$.form', fieldNames)
  const commands = raw.commands.map((c, i) => decodeCommand(c, `$.commands[${i}]`))
  const cmdKeys = new Set(commands.map((c) => c.key))
  if (cmdKeys.size !== commands.length) fail('$.commands', 'command key 重复')

  // create-required 字段在 basic form 中必须可出现在 create 模式
  if (form.kind === 'basic') {
    const createVisible = new Set<string>()
    const placed = collectLayoutFieldNames(form.layout)
    const placementByField = new Map<string, BasicFormFieldPlacement>()
    const walk = (items: BasicFormFieldPlacement[] | undefined) => {
      if (!items) return
      for (const p of items) placementByField.set(p.field, p)
    }
    walk(form.layout.fields)
    for (const s of form.layout.sections ?? []) walk(s.fields)
    for (const t of form.layout.tabs ?? []) {
      walk(t.fields)
      for (const s of t.sections ?? []) walk(s.fields)
    }
    for (const name of placed) {
      const p = placementByField.get(name)
      if (!p?.showIn || p.showIn.includes('create')) createVisible.add(name)
    }
    for (const field of fields) {
      if (field.input.create === 'required' && !createVisible.has(field.name)) {
        fail(
          '$.form.layout',
          `create-required 字段 ${field.name} 必须出现在 create 布局`,
        )
      }
    }
  }

  let authz: ResourceDocumentAuthz | undefined
  if (raw.authz !== undefined) {
    authz = decodeAuthz(raw.authz, '$.authz')
    if (authz.ownerId && !fieldNames.has(authz.ownerId)) {
      fail('$.authz.ownerId', `引用未知字段: ${authz.ownerId}`)
    }
    if (authz.deptId && !fieldNames.has(authz.deptId)) {
      fail('$.authz.deptId', `引用未知字段: ${authz.deptId}`)
    }
  }

  return {
    schemaVersion: RESOURCE_DOCUMENT_SCHEMA_VERSION,
    name: asString(raw.name, '$.name'),
    label: asString(raw.label, '$.label'),
    permissionPrefix: asString(raw.permissionPrefix, '$.permissionPrefix'),
    capabilities: decodeCapabilities(raw.capabilities, '$.capabilities'),
    ...(authz ? { authz } : {}),
    fields,
    lookup,
    list,
    form,
    commands,
  }
}

/** 类型守卫：成功则返回 true */
export function isResourceDocument(raw: unknown): raw is ResourceDocument {
  try {
    decodeResourceDocument(raw)
    return true
  } catch {
    return false
  }
}
