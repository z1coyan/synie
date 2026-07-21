import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, Spinner, Table, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import type { Row } from '~/components/synie-data-grid/types'

/** 审核确认弹窗的条目列定义(render 缺省时按文本原样展示) */
export interface AuditItemColumn {
  key: string
  label: string
  align?: 'start' | 'end'
  render?: (value: unknown, row: Row) => ReactNode
}

/** useAuditDoc 配置:按单据模块给一份(通常写在模块 -drawer 文件里),条目页/单据页共用 */
export interface AuditDocConfig {
  /** 单据中文名(弹窗标题/toast),如「销售发货单」 */
  docLabel: string
  /** 审核 mutation 名(与后端 grid_actions 下发一致),如 auditSalDelivery */
  mutation: string
  /** 条目资源名,如 salDeliveryItems */
  itemsResource: string
  /** 条目上的母单外键字段(camelCase),如 deliveryId */
  docIdField: string
  /** 条目查询字段集(只取快照/计算字段,不 join 会触发嵌套授权的 fk) */
  itemFields: string
  /** 确认弹窗展示的条目列 */
  columns: AuditItemColumn[]
}

/** 物料快照单元格:编号+名称一行,规格/客户料号等次行小字(与各条目网格同一套展示) */
export function auditMaterialCell(extra?: { key: string; label: string }) {
  return (_v: unknown, r: Row): ReactNode => {
    const code = r.materialCode != null ? String(r.materialCode) : ''
    const name = r.materialName != null ? String(r.materialName) : ''
    const title = [code, name].filter(Boolean).join(' ')
    const spec = r.materialSpec != null && r.materialSpec !== '' ? String(r.materialSpec) : null
    const extraVal =
      extra && r[extra.key] != null && r[extra.key] !== '' ? String(r[extra.key]) : null
    if (!title && !spec && !extraVal) return undefined
    return (
      <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
        {title ? <span className="truncate font-medium">{title}</span> : null}
        {spec ? (
          <span className="truncate text-xs text-muted" title={spec}>
            规格 {spec}
          </span>
        ) : null}
        {extraVal ? (
          <span className="truncate text-xs text-muted" title={extraVal}>
            {extra!.label} {extraVal}
          </span>
        ) : null}
      </div>
    )
  }
}

/**
 * 「审核整单」确认弹窗:先拉出整张单据的全部条目列给用户核对,确认后再调审核 mutation。
 * 条目页行操作(不必跳回单据页)与单据页「审核」动作共用同一弹窗。
 * 审核成功后失效 gridRows/rowById 缓存并回调当下表格的 refetch。
 */
export function useAuditDoc(cfg: AuditDocConfig) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<{ docId: string; refetch: () => void } | null>(null)
  const [running, setRunning] = useState(false)

  const itemsQuery = useQuery({
    queryKey: ['auditDocItems', cfg.itemsResource, pending?.docId],
    enabled: pending != null,
    queryFn: () =>
      gqlFetch<Record<string, { results: Row[] }>>(
        `query ($id: ID!) {
          ${cfg.itemsResource}(
            filter: {${cfg.docIdField}: {eq: $id}}
            sort: [{field: IDX, order: ASC}]
            limit: 500
            offset: 0
          ) { results { ${cfg.itemFields} } }
        }`,
        { id: pending!.docId },
      ).then((d) => d[cfg.itemsResource]?.results ?? []),
  })
  const itemRows = itemsQuery.data ?? []

  const confirm = async () => {
    if (!pending) return
    setRunning(true)
    try {
      const data = await gqlFetch<Record<string, { errors: { message: string }[] | null }>>(
        `mutation ($id: ID!) { ${cfg.mutation}(id: $id) { errors { message } } }`,
        { id: pending.docId },
      )
      const errors = data[cfg.mutation]?.errors
      // 业务校验(负库存/超发/科目等)走 payload.errors:留在弹窗里让用户看完原因再决定
      if (errors?.length) {
        toast.danger(`${cfg.docLabel}审核失败`, {
          description: errors.map((e) => e.message).join('; '),
        })
        return
      }
      toast.success(`${cfg.docLabel}已审核`)
      queryClient.invalidateQueries({ queryKey: ['gridRows'] })
      queryClient.invalidateQueries({ queryKey: ['rowById'] })
      pending.refetch()
      setPending(null)
    } catch (e) {
      toast.danger(`${cfg.docLabel}审核失败`, { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  // 渲染为已成型元素而非组件函数(同 use-grid-actions confirmDialog 注释:避免子树重挂载)
  const auditDialog: ReactNode = (
    <AlertDialog.Backdrop
      isOpen={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog
          className="sm:max-w-[720px]"
          aria-label={pending ? `审核${cfg.docLabel}` : '审核确认'}
        >
          {pending && (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status="accent" />
                <AlertDialog.Heading>审核{cfg.docLabel}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                {itemsQuery.isPending ? (
                  <div className="flex h-32 items-center justify-center">
                    <Spinner />
                  </div>
                ) : itemsQuery.isError ? (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-danger">
                      条目加载失败:{(itemsQuery.error as Error).message}
                    </p>
                    <Button variant="secondary" onPress={() => void itemsQuery.refetch()}>
                      重试
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-sm">
                      审核后单据不可再编辑。请核对以下 {itemRows.length} 条条目:
                    </p>
                    <div className="max-h-72 overflow-auto">
                      <Table>
                        <Table.ScrollContainer>
                          <Table.Content aria-label={`${cfg.docLabel}条目核对`}>
                            <Table.Header>
                              {cfg.columns.map((c) => (
                                <Table.Column
                                  key={c.key}
                                  className={c.align === 'end' ? 'text-end' : undefined}
                                >
                                  {c.label}
                                </Table.Column>
                              ))}
                            </Table.Header>
                            <Table.Body>
                              {itemRows.map((r) => (
                                <Table.Row key={r.id}>
                                  {cfg.columns.map((c) => (
                                    <Table.Cell
                                      key={c.key}
                                      className={c.align === 'end' ? 'text-end' : undefined}
                                    >
                                      {c.render
                                        ? c.render(r[c.key], r)
                                        : r[c.key] != null && r[c.key] !== ''
                                          ? String(r[c.key])
                                          : '—'}
                                    </Table.Cell>
                                  ))}
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Content>
                        </Table.ScrollContainer>
                      </Table>
                    </div>
                  </>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={running}
                  isDisabled={itemsQuery.isPending || itemsQuery.isError}
                  onPress={() => void confirm()}
                >
                  确认审核
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return {
    /** 打开审核确认弹窗:docId 为母单 id,refetch 为当下表格的刷新回调 */
    requestAudit: (docId: string, refetch: () => void) => setPending({ docId, refetch }),
    auditDialog,
  }
}
