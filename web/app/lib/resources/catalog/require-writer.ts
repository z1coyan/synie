/**
 * 按操作取 binding 的写能力；不支持时 fail-closed。
 *
 * RecordWriter 的方法按资源实际能力可选，页面此前用
 * `if (!('create' in binding.writer) || !binding.writer.create) throw ...`
 * 逐处收窄；本模块把该防御收敛为一行，报错口径与既有页面一致。
 */
import type { Row } from '~/components/synie-data-grid/types'
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
    throw new Error(`${label ?? binding.resource} 不支持 ${operation}`)
  }
  return fn
}
