import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, Spinner, Table, toast } from '@heroui/react'
import type { Row } from '~/components/synie-data-grid/types'
import {
  materialCellRender,
  type MaterialCellOptions,
} from '~/components/synie-material-cell/MaterialCell'
import type { ResourceBinding } from '~/lib/resources/catalog'
import { resourceBindingFor } from '~/lib/resources/registry'
import { executeSingleRowCommandWithInvalidation } from '~/lib/resources/command-invalidation'

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
  /** 条目资源名,如 salDeliveryItems(用于隔离查询缓存) */
  itemsResource: string
  /** 确认弹窗展示的条目列 */
  columns: AuditItemColumn[]
  /** 通过资源 REST client 读取整单条目 */
  loadItems: (docId: string) => Promise<Row[]>
  /** 审核命令所属 ResourceBinding。 */
  resource: string
  /** ResourceBinding.commands 中的语义命令 key。 */
  commandKey: string
}

/** 审核弹窗物料列:与全系统物料单元格同一组件(图纸缩略图+编号/名称+规格/客编),
 *  条目行有图纸挂接时经 options.drawingOwnerType 声明(快照图纸优先,回退物料当前图纸) */
export function auditMaterialCell(options?: MaterialCellOptions) {
  return materialCellRender(options)
}

export type AuditDocBindingResolver = (
  resource: string,
) => Pick<ResourceBinding, 'cache'>

/** 审核条目查询沿用 items ResourceBinding 的 grid scope，命令 effects 可精确命中。 */
export function auditDocItemsQueryKey(
  itemsResource: string,
  docId: string | undefined,
  resolveBinding: AuditDocBindingResolver = resourceBindingFor,
) {
  return resolveBinding(itemsResource).cache.gridKey(
    'auditDocItems',
    docId,
  )
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
    queryKey: auditDocItemsQueryKey(
      cfg.itemsResource,
      pending?.docId,
    ),
    enabled: pending != null,
    queryFn: () => cfg.loadItems(pending!.docId),
  })
  const itemRows = itemsQuery.data ?? []

  const confirm = async () => {
    if (!pending) return
    setRunning(true)
    try {
      await executeSingleRowCommandWithInvalidation(
        cfg.resource,
        cfg.commandKey,
        pending.docId,
        queryClient,
      )
      toast.success(`${cfg.docLabel}已审核`)
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
