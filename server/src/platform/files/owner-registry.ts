import type { ResourceMeta } from '../meta/types.ts'
import type { OwnerSpec } from './types.ts'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/**
 * 附件宿主白名单：fail-closed，仅注册过的 ownerType 可挂接。
 * 领域包声明 spec，启动期 register；files 层不硬编码业务表名。
 */
export function createOwnerRegistry() {
  const owners = new Map<string, OwnerSpec>()

  function register(ownerType: string, spec: OwnerSpec): void {
    if (!ownerType || !spec.table || !spec.resource) {
      throw new Error(`files: 附件宿主注册不完整 (ownerType=${JSON.stringify(ownerType)})`)
    }
    if (!IDENTIFIER_RE.test(spec.table)) {
      throw new Error(`files: 宿主表名非法: ${spec.table}`)
    }
    if (owners.has(ownerType)) {
      throw new Error(`重复附件宿主注册: ${ownerType}`)
    }
    owners.set(ownerType, { ...spec })
  }

  function lookup(ownerType: string): OwnerSpec | undefined {
    return owners.get(ownerType)
  }

  function snapshot(): ReadonlyMap<string, OwnerSpec> {
    return new Map(owners)
  }

  return { register, lookup, snapshot }
}

export type OwnerRegistry = ReturnType<typeof createOwnerRegistry>

/**
 * 从 Meta Registry 派生附件宿主注册表：声明了 attachments 的资源即宿主。
 * 声明与注册互为镜像（派生即注册，杜绝「声明了却忘注册」的运行时 400）。
 */
export function buildOwnerRegistryFromMeta(resources: ResourceMeta[]): OwnerRegistry {
  const owners = createOwnerRegistry()
  for (const meta of resources) {
    if (!meta.attachments) continue
    owners.register(meta.attachments.ownerType ?? meta.table, {
      resource: meta.name,
      table: meta.table,
    })
  }
  if (owners.snapshot().size === 0) {
    throw new Error('files: 附件宿主注册表为空（Meta Registry 未声明任何 attachments）')
  }
  return owners
}
