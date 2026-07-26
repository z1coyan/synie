import { useRef, useState } from 'react'
import { toast } from '@heroui/react'
import type { Row } from '../synie-data-grid/types'
import type { ResourceClient } from '~/lib/resources/types'
import { isLocalRow } from './editable'

/**
 * 单据页「头 + 子条目」脚手架:需求单/生产入库等同形页面共用。
 * 配合 SynieEditableTable 受控用法:抽屉打开时 load 拉取条目,父表单提交时
 * persistItems 按 snapshot 比对做 删→增→改,返回逐行错误文案(空数组 = 全成功)。
 */
export interface DocItemsConfig {
  /** 条目中文名(加载失败 toast 用),如 "需求行" */
  label: string
  /** 条目资源 REST client。 */
  client: ResourceClient
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
    const request = cfg.client.query({
      limit: 200,
      offset: 0,
      filter: {
        [cfg.docIdField]: {
          kind: 'fk',
          op: 'in',
          values: [docId],
          labels: [],
        },
      },
      sort: { column: 'idx', direction: 'ascending' },
    })
    request
      .then((d) => {
        if (my !== reqIdRef.current) return
        const rows = d.results ?? []
        setItems(rows)
        setItemsSnapshot(rows)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger(`${cfg.label}加载失败`, {
          description: (e as Error).message,
        })
        setItems([])
        setItemsSnapshot([])
      })
  }

  const itemChanged = (before: Row, after: Row): boolean =>
    cfg.itemKeys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))

  /** 父表单提交时调:删除消失的存量行 → 新建 local: 行 → 更新变更行;返回逐行错误 */
  const persistItems = async (docId: string): Promise<string[]> => {
    const errors: string[] = []
    const currentIds = new Set(
      items.filter((r) => !isLocalRow(r)).map((r) => r.id),
    )

    for (const old of itemsSnapshot) {
      if (currentIds.has(old.id)) continue
      try {
        await cfg.client.delete(old.id)
      } catch (error) {
        errors.push(`${String(old.idx ?? '行')}:${(error as Error).message}`)
      }
    }

    for (const row of items) {
      if (isLocalRow(row)) {
        try {
          const input = { [cfg.docIdField]: docId, ...cfg.itemInput(row) }
          await cfg.client.create(input)
        } catch (error) {
          errors.push(`${String(row.idx ?? '行')}:${(error as Error).message}`)
        }
        continue
      }
      const old = itemsSnapshot.find((s) => s.id === row.id)
      if (old && itemChanged(old, row)) {
        try {
          const input = cfg.itemInput(row)
          await cfg.client.update(row.id, input)
        } catch (error) {
          errors.push(`${String(row.idx ?? '行')}:${(error as Error).message}`)
        }
      }
    }
    return errors
  }

  return { items, setItems, itemsLoaded, load, persistItems }
}
