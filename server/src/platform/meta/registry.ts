import type {
  FieldDocument,
  PermissionGroup,
  ResourceDocument,
  ResourceSummary,
} from '@synie/shared'
import { hasPermission, type Actor } from '../authz/actor.ts'
import { ApiError } from '../http/errors.ts'
import {
  buildNormalizedResource,
  projectResourceDocument,
  type NormalizedResource,
} from './catalog-normalize.ts'
import { applyResourceClassification } from './resource-classification.ts'
import type { ResourceMeta } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

export interface SealReport {
  total: number
  typed: number
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
  let sealed = false

  function register(resource: ResourceMeta): void {
    if (sealed) {
      throw new Error(`Registry 已 seal，禁止注册: ${resource.name}`)
    }
    const classified = applyResourceClassification(resource)
    const typed: ResourceMeta = { ...classified, catalogSource: 'typed' }
    validate(typed)
    if (resources.has(typed.name)) {
      throw new Error(`重复 Meta 资源: ${typed.name}`)
    }
    const previous = permissionLabels.get(typed.permissionPrefix)
    if (previous !== undefined && previous !== typed.permissionLabel) {
      throw new Error(
        `共享权限前缀 ${typed.permissionPrefix} 的标签不一致: ${previous} / ${typed.permissionLabel}`,
      )
    }

    const norm = buildNormalizedResource(typed)
    normalized.set(typed.name, norm)
    resources.set(typed.name, typed)
    permissionLabels.set(typed.permissionPrefix, typed.permissionLabel)
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

  function catalogStats(): SealReport {
    return { total: resources.size, typed: resources.size }
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
