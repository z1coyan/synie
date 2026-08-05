import type {
  DataScope,
  FieldDocument,
  PermissionGroup,
  ResourceDocument,
  ResourceSummary,
} from '@synie/shared'
import { assertValidAuditDeclaration } from '../audit/spec.ts'
import { hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import {
  buildNormalizedResource,
  projectResourceDocument,
  type NormalizedResource,
} from './catalog-normalize.ts'
import { applyResourceClassification } from './resource-classification.ts'
import {
  assertAuthzClosure,
  assertValidAuthzDeclaration,
  resolveAuthzBinding,
  resolveAuthzTarget,
  supportedScopesOf,
  type AuthzBinding,
  type AuthzTarget,
} from './resource-authz.ts'
import type { ResourceMeta } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/** 数据范围呈现顺序（宽 → 窄），目录投影按此稳定排序 */
const SCOPE_ORDER: readonly DataScope[] = ['all', 'deptTree', 'dept', 'self']

export interface SealReport {
  total: number
  normalized: number
}

/**
 * Meta Registry / Resource Catalog：
 * 生命周期 register → seal → project/read。
 * 投影仅产出 ResourceDocument v2（contract 后无 v1 grid/form sibling）。
 * Catalog 不提供通用 create/update/delete 或 SQL 保存入口。
 */
export function createRegistry() {
  const resources = new Map<string, ResourceMeta>()
  const normalized = new Map<string, NormalizedResource>()
  const permissionLabels = new Map<string, string>()
  const authzTargets = new Map<string, AuthzTarget>()
  let sealed = false

  function register(resource: ResourceMeta): void {
    if (sealed) {
      throw new Error(`Registry 已 seal，禁止注册: ${resource.name}`)
    }
    const classified = applyResourceClassification(resource)
    validate(classified)
    assertValidAuthzDeclaration(classified)
    if (resources.has(classified.name)) {
      throw new Error(`重复 Meta 资源: ${classified.name}`)
    }
    const previous = permissionLabels.get(classified.permissionPrefix)
    if (previous !== undefined && previous !== classified.permissionLabel) {
      throw new Error(
        `共享权限前缀 ${classified.permissionPrefix} 的标签不一致: ${previous} / ${classified.permissionLabel}`,
      )
    }

    const norm = buildNormalizedResource(classified)
    normalized.set(classified.name, norm)
    resources.set(classified.name, classified)
    permissionLabels.set(classified.permissionPrefix, classified.permissionLabel)
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
    return catalogStats()
  }

  function validateSealClosure(): void {
    const allCodes = new Set(allPermissionCodes())
    for (const resource of resources.values()) {
      const fieldNames = new Set(resource.fields.map((f) => f.apiName))
      assertAuthzClosure(resource, { hasResource: (name) => resources.has(name), allCodes })

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
    const anyOf = resource.authz?.readAnyOf
    if (!anyOf || anyOf.length === 0) {
      return hasPermission(actor, `${resource.permissionPrefix}:read`)
    }
    return anyOf.some((code) => hasPermission(actor, code))
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
   * 按 Actor 投影完整 ResourceDocument v2（唯一 wire envelope）。
   */
  function buildDocument(name: string, actor: Actor): ResourceDocument {
    const resource = resources.get(name)
    if (!resource) throw new ApiError('not_found', '未知的 Meta 资源')
    if (!canRead(resource, actor)) throw new ApiError('forbidden', '无权限访问该资源')

    const capabilities = collectCapabilities(resource, actor)
    const norm = normalized.get(name)
    if (!norm) {
      throw new Error(`Meta 资源 ${name} 缺少 Catalog 规范化结果（须经 register/seal）`)
    }
    return projectResourceDocument(norm, capabilities, (field) =>
      applyRefAvailability(field, actor),
    )
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

  /**
   * 权限目录：前缀 → 动作集 + 支持的数据范围。
   * 声明了 authz.readAnyOf 的资源无独立权限点（只读投影/导入重载），不进目录。
   * supportedScopes 取同前缀各资源声明的**交集**（保守：范围只在全部资源都支持时开放）。
   */
  function permissionCatalog(): PermissionGroup[] {
    const groups = new Map<string, { actions: Set<string>; scopes: Set<DataScope> | null }>()
    for (const resource of resources.values()) {
      if (resource.authz?.readAnyOf && resource.authz.readAnyOf.length > 0) continue
      const group = groups.get(resource.permissionPrefix) ?? {
        actions: new Set<string>(),
        scopes: null,
      }
      for (const action of resource.actions) {
        group.actions.add(action.permissionAction ?? action.key)
      }
      // via 子行不拥有范围（判定递归宿主），不参与交集
      const own = supportedScopesOf(resource)
      if (own.length > 0) {
        const next = new Set(own as DataScope[])
        group.scopes =
          group.scopes === null
            ? next
            : new Set([...group.scopes].filter((scope) => next.has(scope)))
      }
      groups.set(resource.permissionPrefix, group)
    }
    return [...groups.entries()]
      .map(([prefix, group]) => ({
        prefix,
        label: permissionLabels.get(prefix) ?? prefix,
        actions: [...group.actions].sort(),
        supportedScopes: SCOPE_ORDER.filter((scope) => group.scopes?.has(scope) ?? false),
      }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
  }

  /** 已解析的授权绑定（列名已定）；执行面（guard / compileRowFilter / 盖章）消费 */
  function authzBinding(name: string): AuthzBinding | undefined {
    const resource = resources.get(name)
    return resource ? resolveAuthzBinding(resource) : undefined
  }

  /**
   * 已解析的判定归宿（via 链 + 列绑定）：guard 与各服务的 listAuthorized/loadAuthorized
   * 共用**同一份**解析结果。seal 后记忆化（seal 前不缓存，避免注册中途的半成品被固化）。
   */
  function authzTarget(name: string): AuthzTarget {
    const hit = authzTargets.get(name)
    if (hit) return hit
    const target = resolveAuthzTarget(name, (n) => resources.get(n))
    if (sealed) authzTargets.set(name, target)
    return target
  }

  /**
   * 全部权限码（目录派生，字典序）：`sys_role.grants_all` 展开与授权 sync 闭包校验的共同基准。
   */
  function allPermissionCodes(): string[] {
    return permissionCatalog()
      .flatMap((group) => group.actions.map((action) => `${group.prefix}:${action}`))
      .sort()
  }

  function catalogStats(): SealReport {
    return { total: resources.size, normalized: normalized.size }
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
    authzBinding,
    authzTarget,
    allPermissionCodes,
    catalogStats,
  }
}

export type Registry = ReturnType<typeof createRegistry>

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
  for (const fieldName of resource.form?.exclude ?? []) {
    if (!fields.has(fieldName)) {
      throw new Error(`Meta 资源 ${resource.name} form.exclude 引用未知字段: ${fieldName}`)
    }
  }
  for (const fieldName of Object.keys(resource.form?.fields ?? {})) {
    if (!fields.has(fieldName)) {
      throw new Error(`Meta 资源 ${resource.name} form.fields 引用未知字段: ${fieldName}`)
    }
  }
  const actions = new Set<string>()
  for (const action of resource.actions) {
    if (!action.key) throw new Error(`Meta 资源 ${resource.name} 存在空动作`)
    if (actions.has(action.key)) {
      throw new Error(`Meta 资源 ${resource.name} 重复动作: ${action.key}`)
    }
    actions.add(action.key)
  }
  // 审计声明自洽（exclude/extra 对得上字段清单）；注册期 fail-closed
  assertValidAuditDeclaration(resource)
}
