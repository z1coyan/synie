/**
 * Command effects → ResourceBinding cache 的唯一 implementation。
 *
 * 调用者只提供命令所属 binding、语义 key、输入与 Query invalidation Adapter；
 * effects 解析、命令执行、安全兜底、去重和 fail-closed 都留在本 module 内。
 */
import type { ResourceBinding } from './catalog'
import type { QueryInvalidationAdapter } from './catalog/query-cache'
import { resourceBindingFor } from './registry'

const COMMAND_AUDIT_RESOURCE = 'sysAuditLogs'

export type ResourceBindingResolver = (resource: string) => ResourceBinding

/**
 * 先 preflight 完整 effects，再执行任意 target 的领域命令，成功后才失效缓存。
 *
 * source 作为参数而不是再次从 registry 解析，使测试/本地 binding 仍保留自己的
 * Reader cache identity；跨资源 effects 继续从同一个 ResourceBinding resolver 解析。
 * metadata 拼错时 handler 不会运行，避免“命令已成功但 UI 报失败”后被重复提交。
 */
export async function executeCommandWithInvalidation(
  source: ResourceBinding,
  commandKey: string,
  input: unknown,
  cache: QueryInvalidationAdapter,
  resolveBinding: ResourceBindingResolver = resourceBindingFor,
): Promise<unknown> {
  const command = source.commands?.commands[commandKey]
  const commands = source.commands
  if (!commands || !command) {
    throw new Error(
      `资源「${source.resource}」未绑定命令「${commandKey}」`,
    )
  }

  const affectedResources = [
    ...new Set([
      source.resource,
      COMMAND_AUDIT_RESOURCE,
      ...(command.affectedResources ?? []),
    ]),
  ]

  // 先解析完整集合，再执行 handler；配置了未知资源时不产生领域写入或半失效状态。
  const affectedCaches = affectedResources.map(
    (affectedResource) =>
      affectedResource === source.resource
        ? source.cache
        : resolveBinding(affectedResource).cache,
  )
  const result = await commands.execute(commandKey, input as never)
  await Promise.all(
    affectedCaches.map((affectedCache) =>
      affectedCache.invalidateAll(cache),
    ),
  )
  return result
}

/** Generic Drawer / AuditDoc 的单记录便利入口。 */
export async function executeSingleRowCommandWithInvalidation(
  resource: string,
  commandKey: string,
  id: string,
  cache: QueryInvalidationAdapter,
  resolveBinding: ResourceBindingResolver = resourceBindingFor,
): Promise<unknown> {
  return await executeCommandWithInvalidation(
    resolveBinding(resource),
    commandKey,
    { id },
    cache,
    resolveBinding,
  )
}
