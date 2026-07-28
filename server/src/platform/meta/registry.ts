import type {
  GridActionMeta,
  GridColumnMeta,
  GridColumnRef,
  PermissionGroup,
  ResourceMetaDocument,
  ResourceSummary,
} from '@synie/shared'
import { hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import type { ResourceMeta } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/**
 * Meta Registry：资源元数据的进程内权威源（字段定义不入库，对齐权限点先例）。
 * 注册发生在启动期，非法/重复注册直接抛错使进程起不来（fail-closed）。
 */
export function createRegistry() {
  const resources = new Map<string, ResourceMeta>()
  const permissionLabels = new Map<string, string>()

  function register(resource: ResourceMeta): void {
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
    resources.set(resource.name, resource)
    permissionLabels.set(resource.permissionPrefix, resource.permissionLabel)
  }

  function get(name: string): ResourceMeta | undefined {
    return resources.get(name)
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

  /** Grid 文档：按 Actor 投影列/能力/扩展动作（无权读取的引用降级为原始 ID 列） */
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

    const capabilities: string[] = []
    const seen = new Set<string>()
    const extendedActions: GridActionMeta[] = []
    for (const action of resource.actions) {
      const permissionAction = action.permissionAction ?? action.key
      if (permissionAction !== 'read' && hasPermission(actor, `${resource.permissionPrefix}:${permissionAction}`)) {
        if (!seen.has(permissionAction)) {
          seen.add(permissionAction)
          capabilities.push(permissionAction)
        }
      }
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

    return {
      name: resource.name,
      grid: {
        columns,
        capabilities,
        extendedActions,
        destroyMutation: resource.destroyMutation ?? null,
      },
      ...(resource.form ? { form: resource.form } : {}),
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

  return { register, get, buildDocument, summaries, permissionCatalog }
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
