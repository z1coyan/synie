import { useRef, useState } from 'react'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import type { Row } from '../synie-data-grid/types'
import { isLocalRow } from './editable'

/**
 * 单据页「头 + 子条目」脚手架:需求单/生产入库等同形页面共用。
 * 配合 SynieEditableTable 受控用法:抽屉打开时 load 拉取条目,父表单提交时
 * persistItems 按 snapshot 比对做 删→增→改,返回逐行错误文案(空数组 = 全成功)。
 */
export interface DocItemsConfig {
  /** 条目中文名(加载失败 toast 用),如 "需求行" */
  label: string
  /** 条目 list query 文档:变量固定 ($docId: ID!),母单外键 filter 内联在文档里 */
  fetchQuery: string
  /** 查询返回顶层 key,如 "mfgDemandItems" */
  fetchKey: string
  /** create mutation 文档与返回顶层 key(input 里母单外键由 hook 补) */
  createMutation: string
  createKey: string
  /** update mutation 文档与返回顶层 key */
  updateMutation: string
  updateKey: string
  /** destroy mutation 文档与返回顶层 key */
  destroyMutation: string
  destroyKey: string
  /** create input 的母单外键字段名,如 "demandId" */
  docIdField: string
  /** 行 → create/update input(母单外键除外) */
  itemInput: (row: Row) => Record<string, unknown>
  /** 存量行变更判别字段集(逐字段字符串化比对) */
  itemKeys: readonly string[]
}

export function useDocItems(cfg: DocItemsConfig) {
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  // 竞态守卫:连续打开不同行时只接受最后一次 load 的结果
  const reqIdRef = useRef(0)

  /** 打开抽屉时调:传 null(新建)清空;否则拉取该单条目 */
  const load = (docId: string | null) => {
    const my = ++reqIdRef.current
    if (docId == null) {
      setItems([])
      setItemsSnapshot([])
      setItemsLoaded(true)
      return
    }
    setItemsLoaded(false)
    gqlFetch<Record<string, { results: Row[] }>>(cfg.fetchQuery, { docId })
      .then((d) => {
        if (my !== reqIdRef.current) return
        const rows = d[cfg.fetchKey]?.results ?? []
        setItems(rows)
        setItemsSnapshot(rows)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger(`${cfg.label}加载失败`, { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }

  const itemChanged = (before: Row, after: Row): boolean =>
    cfg.itemKeys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))

  /** 父表单提交时调:删除消失的存量行 → 新建 local: 行 → 更新变更行;返回逐行错误 */
  const persistItems = async (docId: string): Promise<string[]> => {
    const errors: string[] = []
    const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
      if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
    }
    const currentIds = new Set(items.filter((r) => !isLocalRow(r)).map((r) => r.id))

    for (const old of itemsSnapshot) {
      if (currentIds.has(old.id)) continue
      const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
        cfg.destroyMutation,
        { id: old.id },
      )
      collect(old.idx ?? '行', data[cfg.destroyKey]?.errors)
    }

    for (const row of items) {
      if (isLocalRow(row)) {
        const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
          cfg.createMutation,
          { input: { [cfg.docIdField]: docId, ...cfg.itemInput(row) } },
        )
        collect(row.idx ?? '行', data[cfg.createKey]?.errors)
        continue
      }
      const old = itemsSnapshot.find((s) => s.id === row.id)
      if (old && itemChanged(old, row)) {
        const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
          cfg.updateMutation,
          { id: row.id, input: cfg.itemInput(row) },
        )
        collect(row.idx ?? '行', data[cfg.updateKey]?.errors)
      }
    }
    return errors
  }

  return { items, setItems, itemsLoaded, load, persistItems }
}
