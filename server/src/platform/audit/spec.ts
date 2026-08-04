/**
 * 审计规格派生：以 ResourceMeta.audit 声明为唯一事实源，
 * 消灭 service 手抄的 AUDIT 字段数组与 sensitiveFields 字面量。
 *
 * 派生规则：非 calculated 物理字段 − (id/inserted_at/updated_at) − audit.exclude，
 * 可选 rename（多侧共用引擎的通用审计键，如 delivery_no→number），再追加 audit.extra。
 *
 * fail-closed：meta 未声明 audit.enabled、exclude/extra/rename 与字段清单不符时抛错
 * （service 在模块顶层派生 → 启动即炸，抓声明漂移与 typo）。
 */
import type { ResourceMeta } from '../meta/types.ts'

/** 所有资源一致的基础排除列（不进审计 diff） */
const BASE_EXCLUDED = new Set(['id', 'inserted_at', 'updated_at'])

export interface ResourceAuditSpec {
  /** 审计字段白名单（含 audit.extra；直接喂 auditCreated/auditDiff/auditDestroyed） */
  fields: readonly string[]
  /** 不含 audit.extra 的白名单（个别 destroy 路径只审物理字段，如 sys_user） */
  metaFields: readonly string[]
  /** 直接可传 writeAudit.sensitiveFields（未声明时为 undefined） */
  sensitiveFields: readonly string[] | undefined
}

export interface AuditSpecOptions {
  /** 物理列名 → 审计键重命名（多侧共用引擎的通用键；键必须是派生白名单内的列） */
  rename?: Readonly<Record<string, string>>
}

/** meta 的可派生物理字段名集合（audit 声明校验与派生共用） */
function physicalAuditFieldNames(meta: ResourceMeta): Set<string> {
  return new Set(
    meta.fields.filter((f) => !f.calculated && !BASE_EXCLUDED.has(f.name)).map((f) => f.name),
  )
}

/**
 * audit 声明自洽校验（Registry 注册期调用，未被 service 派生的声明同样 fail-closed）。
 */
export function assertValidAuditDeclaration(meta: ResourceMeta): void {
  const audit = meta.audit
  if (!audit) return
  const physical = physicalAuditFieldNames(meta)
  for (const name of audit.exclude ?? []) {
    if (!physical.has(name)) {
      throw new Error(`Meta 资源 ${meta.name} audit.exclude 引用未知物理字段: ${name}`)
    }
  }
  for (const name of audit.extra ?? []) {
    if (physical.has(name)) {
      throw new Error(`Meta 资源 ${meta.name} audit.extra 与物理字段重复: ${name}`)
    }
  }
}

/** 从 ResourceMeta 派生审计规格（meta.audit.enabled 必须为 true） */
export function auditSpecOf(meta: ResourceMeta, options?: AuditSpecOptions): ResourceAuditSpec {
  const audit = meta.audit
  if (!audit?.enabled) {
    throw new Error(`资源 ${meta.name} 未声明 audit.enabled，不能派生审计规格`)
  }
  assertValidAuditDeclaration(meta)
  const physical = physicalAuditFieldNames(meta)
  const exclude = new Set(audit.exclude ?? [])
  const rename = options?.rename ?? {}
  for (const from of Object.keys(rename)) {
    if (!physical.has(from) || exclude.has(from)) {
      throw new Error(`资源 ${meta.name} 审计 rename 引用不在白名单内的列: ${from}`)
    }
  }
  const metaFields: string[] = []
  for (const field of meta.fields) {
    if (field.calculated || BASE_EXCLUDED.has(field.name) || exclude.has(field.name)) continue
    metaFields.push(rename[field.name] ?? field.name)
  }
  const fields = [...metaFields, ...(audit.extra ?? [])]
  if (new Set(fields).size !== fields.length) {
    throw new Error(`资源 ${meta.name} 审计白名单存在重复键（检查 rename/extra）`)
  }
  return {
    fields,
    metaFields,
    sensitiveFields:
      audit.sensitiveFields && audit.sensitiveFields.length > 0
        ? [...audit.sensitiveFields]
        : undefined,
  }
}

/** 便捷入口：只要白名单（最常见形态） */
export function auditFieldsOf(meta: ResourceMeta, options?: AuditSpecOptions): readonly string[] {
  return auditSpecOf(meta, options).fields
}

/** 多侧共用引擎（销售/采购）白名单并集：保序去重 */
export function mergeAuditFields(
  ...lists: ReadonlyArray<readonly string[]>
): readonly string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const name of list) {
      if (seen.has(name)) continue
      seen.add(name)
      merged.push(name)
    }
  }
  return merged
}

/** 动作级局部审计面（如 sys_setting 行情拉取记录）：子集越界即抛错 */
export function pickAuditFields(
  fields: readonly string[],
  subset: readonly string[],
): readonly string[] {
  const all = new Set(fields)
  for (const name of subset) {
    if (!all.has(name)) {
      throw new Error(`审计子集包含白名单外字段: ${name}`)
    }
  }
  return [...subset]
}
