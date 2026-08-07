/**
 * 子行差异持久化工厂：删缺失 → 建新增 → 改变更。
 *
 * 对标各页面手写的 15 份 persist* 循环 + itemChanged + COMPARE_KEYS。
 * 暂无整单 replaceDraft 端点的资源统一走本工厂做 diff；后端聚合波次到位后可切
 * replaceDraft。物料单位 / 工艺步骤 / 编号外的单据子表等同构循环一并收口。
 *
 * 语义：
 * - 快照有、当前无 → delete（可 skipDelete 跳过级联已清的行）
 * - 当前 local: 行 → create
 * - 当前存量且 compareKeys/changed 有变 → update
 * - 全程收集错误文案、不中途抛出；文案形态 `${rowLabel}:message`
 */
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { Row } from '~/components/synie-data-grid/types'

/** 子行写端：create / update / delete；与 ResourceClient 写面兼容。 */
export interface ChildRowWriter {
  create(input: Record<string, unknown>): Promise<unknown>
  update(id: string, input: Record<string, unknown>): Promise<unknown>
  delete(id: string): Promise<unknown>
}

/**
 * 按字段键比对两行是否有业务变更（String 化后相等则视为无变）。
 * 替代各处手写的 `COMPARE_KEYS.some(...)` / `itemChanged`。
 */
export function rowChangedByKeys(
  keys: readonly string[],
): (before: Row, after: Row) => boolean {
  return (before, after) =>
    keys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

export type PersistChildRowOp = 'delete' | 'create' | 'update'

export interface PersistChildRowsOptions {
  readonly current: readonly Row[]
  readonly snapshot: readonly Row[]
  readonly client: ChildRowWriter
  /** create/update body（不含父键时配合 parentIdField） */
  readonly inputOf: (row: Row) => Record<string, unknown>
  /**
   * 比对字段；与 `changed` 二选一（都给时 `changed` 优先）。
   * 缺省且无 changed 时：存量行一律 update（仅特殊场景；常规应给 keys）。
   */
  readonly compareKeys?: readonly string[]
  readonly changed?: (before: Row, after: Row) => boolean
  /**
   * create 时并入父外键：`{ [parentIdField]: parentId, ...inputOf(row) }`。
   * 父键已在 inputOf 内则不必填。
   */
  readonly parentIdField?: string
  readonly parentId?: string
  /**
   * 错误定位标签。缺省 `第${row.idx}行`（与凭证/库存/对账等多数页面一致）。
   * `index` 为 current 数组下标（delete 时为 -1）。
   */
  readonly rowLabel?: (
    row: Row,
    ctx: { op: PersistChildRowOp; index: number },
  ) => string
  /** 快照行跳过 delete（如级联随父条目已删） */
  readonly skipDelete?: (old: Row) => boolean
}

function defaultRowLabel(row: Row): string {
  return `第${row.idx}行`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 执行删→建→改 diff，返回逐行错误文案（空数组 = 全成功）。
 */
export async function persistChildRows(
  opts: PersistChildRowsOptions,
): Promise<string[]> {
  const errors: string[] = []
  const labelOf =
    opts.rowLabel ??
    ((row: Row) => defaultRowLabel(row))
  const changed =
    opts.changed ??
    (opts.compareKeys
      ? rowChangedByKeys(opts.compareKeys)
      : () => true)

  const pushError = (
    row: Row,
    op: PersistChildRowOp,
    index: number,
    error: unknown,
  ) => {
    errors.push(`${labelOf(row, { op, index })}:${errorMessage(error)}`)
  }

  const currentIds = new Set(
    opts.current.filter((r) => !isLocalRow(r)).map((r) => r.id),
  )

  for (const old of opts.snapshot) {
    if (currentIds.has(old.id)) continue
    if (opts.skipDelete?.(old)) continue
    try {
      await opts.client.delete(String(old.id))
    } catch (error) {
      pushError(old, 'delete', -1, error)
    }
  }

  for (const [index, row] of opts.current.entries()) {
    if (isLocalRow(row)) {
      const body =
        opts.parentIdField != null && opts.parentId !== undefined
          ? { [opts.parentIdField]: opts.parentId, ...opts.inputOf(row) }
          : opts.inputOf(row)
      try {
        await opts.client.create(body)
      } catch (error) {
        pushError(row, 'create', index, error)
      }
      continue
    }
    const old = opts.snapshot.find((s) => s.id === row.id)
    if (old && changed(old, row)) {
      try {
        await opts.client.update(String(row.id), opts.inputOf(row))
      } catch (error) {
        pushError(row, 'update', index, error)
      }
    }
  }

  return errors
}
