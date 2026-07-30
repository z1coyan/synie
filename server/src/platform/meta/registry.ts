import type {
  FieldDocument,
  GridActionMeta,
  GridColumnMeta,
  GridColumnRef,
  PermissionGroup,
  ResourceMetaDocument,
  ResourceSummary,
} from '@synie/shared'
import { hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import {
  LEGACY_NORMALIZER_MARK,
  normalizeLegacyResourceMeta,
  projectResourceDocument,
  type NormalizedResource,
} from './legacy-normalize.ts'
import type { ResourceMeta } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

export interface SealReport {
  total: number
  legacy: number
  typed: number
}

/**
 * Meta Registry / Resource Catalog：
 * 生命周期 register → seal → project/read。
 * seal 后禁止继续注册；投影同时产出 v1 Grid/Form 与 v2 catalog。
 * Catalog 不提供通用 create/update/delete 或 SQL 保存入口。
 */
export function createRegistry() {
  const resources = new Map<string, ResourceMeta>()
  const normalized = new Map<string, NormalizedResource>()
  const permissionLabels = new Map<string, string>()
  let sealed = false

  function register(resource: ResourceMeta): void {
    if (sealed) {
      throw new Error(`Registry 已 seal，禁止注册: ${resource.name}`)
    }
    validate(resource)
    if (resources.has(resource.name)) {
      throw new Error(`重复 Meta 资源: ${resource.name}`)
    }
    const previous = permissionLabels.get(resource.permissionPrefix)
    if (previous !== undefined && previous !== resource.permissionLabel) {
      throw new Error(
        `共享权限前缀 ${resource.permissionPrefix} 的标签不一致: ${previous} / ${resource.permissionLabel}`,
      )
    }

    // expand 期存量定义一律经 legacy normalizer；typed 路径预留给后续工单
    const source = resource.catalogSource ?? 'legacy'
    if (source === 'legacy') {
      const norm = normalizeLegacyResourceMeta(resource)
      normalized.set(resource.name, norm)
    } else {
      // typed：仍存 ResourceMeta 兼容 get/list/filterbuild；v2 规范化后续工单补全
      const norm = normalizeLegacyResourceMeta(resource)
      normalized.set(resource.name, { ...norm, source: LEGACY_NORMALIZER_MARK })
    }

    resources.set(resource.name, resource)
    permissionLabels.set(resource.permissionPrefix, resource.permissionLabel)
  }

  function get(name: string): ResourceMeta | undefined {
    return resources.get(name)
  }

  /** 全部已注册资源（打印字段目录等派生消费） */
  function list(): ResourceMeta[] {
    return [...resources.values()]
  }

  function isSealed(): boolean {
    return sealed
  }

  /**
   * 启动期 seal：跨资源引用、lookup、布局、printLoops 校验；之后 Registry 不可变。
   */
  function seal(): SealReport {
    if (sealed) {
      throw new Error('Registry 已 seal，禁止重复 seal')
    }
    validateSealClosure()
    sealed = true
    let legacy = 0
    let typed = 0
    for (const resource of resources.values()) {
      if ((resource.catalogSource ?? 'legacy') === 'typed') typed++
      else legacy++
    }
    return { total: resources.size, legacy, typed }
  }

  function validateSealClosure(): void {
    for (const resource of resources.values()) {
      const fieldNames = new Set(resource.fields.map((f) => f.apiName))

      for (const field of resource.fields) {
        if (field.type === 'enum' || field.type === 'enumArray') {
          if (!field.enumOptions || field.enumOptions.length === 0) {
            throw new Error(`Meta 资源 ${resource.name} 枚举字段 ${field.apiName} 缺少 options`)
          }
        }
        if (field.ref?.resource) {
          if (!resources.has(field.ref.resource)) {
            throw new Error(
              `Meta 资源 ${resource.name} 字段 ${field.apiName} 引用未知资源: ${field.ref.resource}`,
            )
          }
          if (field.ref.labelField) {
            const target = resources.get(field.ref.resource)!
            const ok = target.fields.some((f) => f.apiName === field.ref!.labelField)
            if (!ok) {
              throw new Error(
                `Meta 资源 ${resource.name} 字段 ${field.apiName} 的 labelField ${field.ref.labelField} 在 ${field.ref.resource} 中不存在`,
              )
            }
          }
        }
        if (field.ref?.variants) {
          for (const variant of field.ref.variants) {
            if (!resources.has(variant.resource)) {
              throw new Error(
                `Meta 资源 ${resource.name} 字段 ${field.apiName} 多态变体引用未知资源: ${variant.resource}`,
              )
            }
          }
          if (field.ref.discriminator && !fieldNames.has(field.ref.discriminator)) {
            // discriminator 可能是 db/api 名；允许 apiName 或 name
            const byName = resource.fields.some(
              (f) => f.apiName === field.ref!.discriminator || f.name === field.ref!.discriminator,
            )
            if (!byName) {
              throw new Error(
                `Meta 资源 ${resource.name} 字段 ${field.apiName} 的 discriminator ${field.ref.discriminator} 不在本资源字段中`,
              )
            }
          }
        }
      }

      if (resource.printLoops) {
        for (const loop of resource.printLoops) {
          if (!resources.has(loop.resource)) {
            throw new Error(
              `Meta 资源 ${resource.name} printLoop ${loop.name} 引用未知资源: ${loop.resource}`,
            )
          }
        }
      }

      const norm = normalized.get(resource.name)
      if (!norm) {
        throw new Error(`Meta 资源 ${resource.name} 缺少 Catalog 规范化结果`)
      }
      if (norm.form.kind === 'basic') {
        const placed = collectBasicFieldNames(norm.form)
        for (const name of placed) {
          if (!norm.fields.some((f) => f.name === name)) {
            throw new Error(`Meta 资源 ${resource.name} 布局引用未知字段: ${name}`)
          }
        }
      }
      if (!norm.fields.some((f) => f.name === norm.lookup.labelField)) {
        throw new Error(
          `Meta 资源 ${resource.name} lookup.labelField ${norm.lookup.labelField} 不存在`,
        )
      }
    }
  }

  function canRead(resource: ResourceMeta, actor: Actor | null): boolean {
    if (!actor) return false
    const anyOf = resource.readPermissionsAny
    if (!anyOf || anyOf.length === 0) {
      return hasPermission(actor, `${resource.permissionPrefix}:read`)
    }
    return anyOf.some((code) => hasPermission(actor, code))
  }

  /**
   * 投影引用：无权目标降级；Grid wire 对齐 Go omitempty（null 键不输出）。
   * 普通 fk 带 resource/relation/labelField；多态 fk 仅 discriminator/discriminatorType/variants。
   */
  function visibleRef(ref: GridColumnRef | undefined, actor: Actor): GridColumnRef | null {
    if (!ref) return null
    if (actor.superAdmin) return projectWireRef(ref)
    if (ref.resource) {
      const target = resources.get(ref.resource)
      return target && canRead(target, actor) ? projectWireRef(ref) : null
    }
    if (!ref.variants || ref.variants.length === 0) return null
    const variants = ref.variants.filter((variant) => {
      const target = resources.get(variant.resource)
      return target !== undefined && canRead(target, actor)
    })
    return variants.length > 0 ? projectWireRef({ ...ref, variants }) : null
  }

  function projectWireRef(ref: GridColumnRef): GridColumnRef {
    const out: Record<string, unknown> = {}
    if (ref.resource != null) out.resource = ref.resource
    if (ref.relation != null) out.relation = ref.relation
    if (ref.labelField != null) out.labelField = ref.labelField
    if (ref.discriminator != null) out.discriminator = ref.discriminator
    if (ref.discriminatorType != null) out.discriminatorType = ref.discriminatorType
    if (ref.variants != null) out.variants = ref.variants
    return out as unknown as GridColumnRef
  }

  function collectCapabilities(resource: ResourceMeta, actor: Actor): string[] {
    const capabilities: string[] = []
    const seen = new Set<string>()
    for (const action of resource.actions) {
      const permissionAction = action.permissionAction ?? action.key
      if (
        permissionAction !== 'read' &&
        hasPermission(actor, `${resource.permissionPrefix}:${permissionAction}`)
      ) {
        if (!seen.has(permissionAction)) {
          seen.add(permissionAction)
          capabilities.push(permissionAction)
        }
      }
    }
    return capabilities
  }

  function applyRefAvailability(field: FieldDocument, actor: Actor): FieldDocument {
    if (field.kind === 'reference') {
      if (!field.targetResource) {
        return { ...field, targetUnavailable: true }
      }
      if (actor.superAdmin) return field
      const target = resources.get(field.targetResource)
      if (!target || !canRead(target, actor)) {
        return { ...field, targetUnavailable: true }
      }
      return field
    }
    if (field.kind === 'polymorphicReference') {
      if (actor.superAdmin) return field
      const variants = field.variants.filter((v) => {
        const target = resources.get(v.resource)
        return target !== undefined && canRead(target, actor)
      })
      if (variants.length === 0) {
        return { ...field, variants: [], targetUnavailable: true }
      }
      if (variants.length !== field.variants.length) {
        return { ...field, variants }
      }
      return field
    }
    return field
  }

  /**
   * 双投影：旧 name/grid/form + catalog v2。
   * Grid 与 v2 均从同一 ResourceMeta / NormalizedResource 派生，禁止双写字段事实。
   */
  function buildDocument(name: string, actor: Actor): ResourceMetaDocument {
    const resource = resources.get(name)
    if (!resource) throw new ApiError('not_found', '未知的 Meta 资源')
    if (!canRead(resource, actor)) throw new ApiError('forbidden', '无权限访问该资源')

    const columns: GridColumnMeta[] = []
    for (const field of resource.fields) {
      if (field.sensitive || field.printOnly) continue
      const ref = visibleRef(field.ref, actor)
      let type = field.type === 'uuid' ? 'string' : field.type
      let sortable = field.sortable ?? false
      let filterable = field.filterable ?? false
      if (ref) {
        type = 'fk'
      } else if (field.ref) {
        // 与旧 GridMeta 契约一致：无权读取引用目标时只暴露原始 ID，
        // 不允许沿不可见关系筛选，但允许按物理 ID 排序。
        type = 'string'
        sortable = true
        filterable = false
      }
      columns.push({
        name: field.apiName,
        type: type as GridColumnMeta['type'],
        label: field.label,
        sortable,
        filterable,
        enumOptions: field.enumOptions ?? null,
        ref,
      })
    }

    const capabilities = collectCapabilities(resource, actor)
    const extendedActions: GridActionMeta[] = []
    for (const action of resource.actions) {
      if (!STANDARD_ACTION_SET.has(action.key)) {
        extendedActions.push({
          key: action.key,
          label: action.label,
          scope: action.scope,
          mutation: action.mutation ?? '',
          isDanger: action.isDanger ?? false,
          ...(action.http ? { http: action.http } : {}),
          ...(action.confirmKind ? { confirmKind: action.confirmKind } : {}),
        })
      }
    }

    const norm = normalized.get(name) ?? normalizeLegacyResourceMeta(resource)
    const catalog = projectResourceDocument(norm, capabilities, (field) =>
      applyRefAvailability(field, actor),
    )

    return {
      name: resource.name,
      grid: {
        columns,
        capabilities,
        extendedActions,
        destroyMutation: resource.destroyMutation ?? null,
      },
      ...(resource.form ? { form: resource.form } : {}),
      catalog,
    }
  }

  function summaries(actor: Actor): ResourceSummary[] {
    return [...resources.values()]
      .filter((resource) => canRead(resource, actor))
      .map((resource) => ({
        name: resource.name,
        permissionPrefix: resource.permissionPrefix,
        permissionLabel: resource.permissionLabel,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 权限目录：前缀 → 动作集（ReadPermissionsAny 投影视图不进目录） */
  function permissionCatalog(): PermissionGroup[] {
    const groups = new Map<string, Set<string>>()
    for (const resource of resources.values()) {
      if (resource.readPermissionsAny && resource.readPermissionsAny.length > 0) continue
      const actions = groups.get(resource.permissionPrefix) ?? new Set<string>()
      for (const action of resource.actions) {
        actions.add(action.permissionAction ?? action.key)
      }
      groups.set(resource.permissionPrefix, actions)
    }
    return [...groups.entries()]
      .map(([prefix, actions]) => ({
        prefix,
        label: permissionLabels.get(prefix) ?? prefix,
        actions: [...actions].sort(),
      }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
  }

  /** seal 报告（未 seal 时返回当前计数） */
  function catalogStats(): SealReport {
    let legacy = 0
    let typed = 0
    for (const resource of resources.values()) {
      if ((resource.catalogSource ?? 'legacy') === 'typed') typed++
      else legacy++
    }
    return { total: resources.size, legacy, typed }
  }

  return {
    register,
    get,
    list,
    seal,
    isSealed,
    buildDocument,
    summaries,
    permissionCatalog,
    catalogStats,
  }
}

export type Registry = ReturnType<typeof createRegistry>

const STANDARD_ACTION_SET = new Set<string>([
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

function collectBasicFieldNames(form: {
  kind: 'basic'
  layout: {
    fields?: { field: string }[]
    sections?: { fields: { field: string }[] }[]
    tabs?: {
      fields?: { field: string }[]
      sections?: { fields: { field: string }[] }[]
    }[]
  }
}): string[] {
  const names: string[] = []
  const take = (items: { field: string }[] | undefined) => {
    if (!items) return
    for (const p of items) names.push(p.field)
  }
  take(form.layout.fields)
  for (const s of form.layout.sections ?? []) take(s.fields)
  for (const t of form.layout.tabs ?? []) {
    take(t.fields)
    for (const s of t.sections ?? []) take(s.fields)
  }
  return names
}

function validate(resource: ResourceMeta): void {
  if (!resource.name || !resource.permissionPrefix || !resource.permissionLabel) {
    throw new Error(`Meta 资源 name/permissionPrefix/permissionLabel 必填: ${resource.name}`)
  }
  if (!IDENTIFIER_RE.test(resource.table)) {
    throw new Error(`Meta 资源 ${resource.name} 的表名非法: ${resource.table}`)
  }
  const fields = new Set<string>()
  for (const field of resource.fields) {
    if (!field.name || !field.apiName || !field.dbColumn || !field.label) {
      throw new Error(`Meta 资源 ${resource.name} 存在不完整字段: ${field.apiName || field.name}`)
    }
    if (!IDENTIFIER_RE.test(field.dbColumn)) {
      throw new Error(`Meta 资源 ${resource.name} 的列名非法: ${field.dbColumn}`)
    }
    if (fields.has(field.apiName)) {
      throw new Error(`Meta 资源 ${resource.name} 重复字段: ${field.apiName}`)
    }
    fields.add(field.apiName)
  }
  const actions = new Set<string>()
  for (const action of resource.actions) {
    if (!action.key) throw new Error(`Meta 资源 ${resource.name} 存在空动作`)
    if (actions.has(action.key)) {
      throw new Error(`Meta 资源 ${resource.name} 重复动作: ${action.key}`)
    }
    actions.add(action.key)
  }
}
