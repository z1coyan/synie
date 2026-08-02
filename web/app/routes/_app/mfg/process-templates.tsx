import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import {
  processTemplateClient,
  processTemplateItemClient,
} from '~/lib/resources/manufacturing'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'
import { useRequestGuard } from '~/lib/use-request-guard'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'mfgProcessTemplates'

export const Route = createFileRoute('/_app/mfg/process-templates')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: ProcessTemplatesPage,
})

// mutation input 只收行自身字段,行上挂的 operation join 对象不进 payload
function itemInput(row: Row) {
  return {
    operationId: row.operationId,
    seq: row.seq,
    requirement: row.requirement ?? null,
    isOutsourced: row.isOutsourced,
  }
}

const ITEM_COMPARE_KEYS = [
  'operationId',
  'seq',
  'requirement',
  'isOutsourced',
] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some(
    (k) => String(before[k] ?? '') !== String(after[k] ?? ''),
  )
}

/** 工艺步骤差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同物料单位转换先例) */
async function persistItems(
  templateId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const itemLabel = (row: Row) =>
    (row.operation as Row | undefined)?.name ?? '工艺步骤'
  const currentIds = new Set(
    current.filter((r) => !isLocalRow(r)).map((r) => r.id),
  )

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    try {
      await processTemplateItemClient.delete(old.id)
    } catch (error) {
      errors.push(`${itemLabel(old)}:${(error as Error).message}`)
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await processTemplateItemClient.create({
          templateId,
          ...itemInput(row),
        })
      } catch (error) {
        errors.push(`${itemLabel(row)}:${(error as Error).message}`)
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      try {
        await processTemplateItemClient.update(row.id, itemInput(row))
      } catch (error) {
        errors.push(`${itemLabel(row)}:${(error as Error).message}`)
      }
    }
  }
  return errors
}

// 列白名单:时间戳不进表格
const GRID_COLUMNS = ['code', 'name', 'note']

function ProcessTemplatesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // edit/view 态工艺步骤靠异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:防止慢响应把上一个模板的步骤行回填到当前模板(同物料先例)
  const guard = useRequestGuard()

  // 深链/点击开抽屉:按 templateId 拉工艺步骤;create 清空;关闭清空
  useEffect(() => {
    const my = guard.begin()
    if (!drawer) {
      setItems([])
      setItemsSnapshot([])
      setItemsLoaded(false)
      return
    }
    if (drawer.mode === 'create' || drawer.recordId == null) {
      setItems([])
      setItemsSnapshot([])
      setItemsLoaded(true)
      return
    }
    setItemsLoaded(false)
    processTemplateItemClient
      .query({
        limit: 200,
        offset: 0,
        filter: {
          templateId: {
            kind: 'fk',
            op: 'in',
            values: [drawer.recordId],
            labels: [],
          },
        },
        sort: { column: 'seq', direction: 'ascending' },
      })
      .then((d) => {
        if (!guard.isCurrent(my)) return
        setItems(d.results)
        setItemsSnapshot(d.results)
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('工艺步骤加载失败')(e)
        setItems([])
        setItemsSnapshot([])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅抽屉身份变化时响应
  }, [drawer?.recordId, drawer?.mode])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">工艺模板</h1>
      <p className="mt-2 text-sm text-ink-500">
        全局共享的工艺路线模板:建 BOM 工艺路线时选模板复制带入为 BOM
        私行,此后模板再改不影响已建 BOM。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        {...drawerConfig(RESOURCE)}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.recordId ?? undefined}
        onEdit={() => setMode('edit')}
        tabExtraContent={{
          items: (mode) => (
            <SynieEditableTable
              resource="mfgProcessTemplateItems"
              label="工艺步骤"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (mode !== 'create' && !itemsLoaded)}
              exclude={['templateId']}
              columns={['seq', 'operationId', 'requirement', 'isOutsourced']}
              fields={{
                operationId: { order: 0, required: true },
                seq: {
                  order: 1,
                  required: true,
                  placeholder: '工序顺序,如 10',
                },
                requirement: { order: 2 },
                isOutsourced: { order: 3, label: '外协', defaultValue: false },
              }}
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (!(
                  Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0
                ))
                  return '序号必须为正整数'
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const created = await processTemplateClient.create(values)
            const templateId = created.id
            const itemErrors = await persistItems(templateId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已创建,但部分工艺步骤保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('工艺模板已创建')
            }
          } else {
            const templateId = String(drawer!.recordId)
            await processTemplateClient.update(templateId, values)
            const itemErrors = await persistItems(
              templateId,
              items,
              itemsSnapshot,
            )
            if (itemErrors.length > 0) {
              toast.danger('工艺模板已更新,但部分工艺步骤保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('工艺模板已更新')
            }
          }
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          await resourceBindingFor(RESOURCE).cache.invalidateAll(queryClient)
        }}
      />
    </>
  )
}
