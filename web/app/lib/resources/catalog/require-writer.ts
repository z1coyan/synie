/**
 * 按操作取 binding 的写能力；不支持时 fail-closed。
 *
 * RecordWriter 的方法按资源实际能力可选，页面此前用
 * `if (!('create' in binding.writer) || !binding.writer.create) throw ...`
 * 逐处收窄；本模块把该防御收敛为一行，报错口径与既有页面一致。
 * 报错资源名缺省读资源事实清单 label（ADR 2026-08-07-resource-manifest），
 * 调用方不再手抄中文名；仅措辞刻意不同于资源 label 时才传第三参。
 */
import type { Row } from '~/components/synie-data-grid/types'
import { resourceLabel } from './resource-label'
import type { ResourceBinding } from './types'

interface WriterOperations {
  create: (input: Record<string, unknown>) => Promise<Row>
  update: (id: string, input: Record<string, unknown>) => Promise<Row>
  delete: (id: string) => Promise<void>
}

export function requireWriter<K extends keyof WriterOperations>(
  binding: ResourceBinding,
  operation: K,
  label?: string,
): WriterOperations[K] {
  const writer = binding.writer as Partial<WriterOperations> | undefined
  const fn = writer?.[operation]
  if (!fn) {
    throw new Error(`${label ?? resourceLabel(binding.resource)} 不支持 ${operation}`)
  }
  return fn
}
