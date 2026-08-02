/**
 * 头字段变更清行守卫(渲染为 null 的表单伴生组件)。
 *
 * 下沉自 9 处抽屉内逐字相同的 ItemsResetGuard(仅指纹字段清单不同,下沉为 fields prop):
 * 指定头字段任一变化即清空条目草稿(已落库行由提交时的快照 diff 走删除,与手动逐行删除同路径)。
 * create 态以首个草稿指纹为基线;edit 态等草稿回填成行值(行到达且指纹一致)才布防,
 * 防「条目先到、行主数据后到」的加载竞态把刚拉回的存量条目误判为变更清掉。
 */
import { useEffect, useRef } from 'react'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

/** 头字段指纹:按 fields 顺序取值,String 化(空值一律 '')后以 | 拼接 */
export function fingerprintOf(v: Record<string, unknown>, fields: readonly string[]): string {
  return fields.map((f) => String(v[f] ?? '')).join('|')
}

export interface ItemsResetGuardState {
  armed: boolean
  baseline: string
}

/**
 * 守卫单步判定(纯函数):
 * view 态不动;未布防时 create 或「指纹与行主数据一致」才布防并记基线;
 * 已布防后指纹变化即更新基线并要求清行。
 */
export function itemsResetGuardStep(
  state: ItemsResetGuardState,
  mode: DrawerMode,
  fp: string,
  rowFp: string | null,
): { state: ItemsResetGuardState; reset: boolean } {
  if (mode === 'view') return { state, reset: false }
  if (!state.armed) {
    if (mode === 'create' || (rowFp != null && fp === rowFp)) {
      return { state: { armed: true, baseline: fp }, reset: false }
    }
    return { state, reset: false }
  }
  if (fp !== state.baseline) return { state: { armed: true, baseline: fp }, reset: true }
  return { state, reset: false }
}

export function ItemsResetGuard({
  mode,
  row,
  values,
  fields,
  onReset,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  /** 指纹字段清单(原各抽屉 fpOf 的字段列表),模块级常量,按此顺序取值 */
  fields: readonly string[]
  onReset: () => void
}) {
  const armedRef = useRef(false)
  const baselineRef = useRef('')
  const fp = fingerprintOf(values, fields)
  const rowFp = row != null ? fingerprintOf(row, fields) : null

  useEffect(() => {
    const next = itemsResetGuardStep(
      { armed: armedRef.current, baseline: baselineRef.current },
      mode,
      fp,
      rowFp,
    )
    armedRef.current = next.state.armed
    baselineRef.current = next.state.baseline
    if (next.reset) onReset()
    // fingerprintOf 每次渲染重建不进依赖;fields 约定为模块级常量;onReset 是 useCallback 稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, rowFp, mode, onReset])

  return null
}
