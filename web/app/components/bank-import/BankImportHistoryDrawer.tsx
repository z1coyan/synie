import { useState } from 'react'
import { AlertDialog, Button, toast } from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { ActionContext, Row } from '~/components/synie-data-grid/types'
import { DESTROY_BANK_IMPORT, throwOnErrors } from './mutations'

const GRID_COLUMNS = [
  'companyId',
  'bankAccountId',
  'templateId',
  'status',
  'itemCount',
  'errorCount',
  'createdById',
  'insertedAt',
]

// 状态胶囊配色:已解析蓝、解析失败红、已导入绿
const GRID_OVERRIDES = {
  status: { enumColors: { PARSED: 'accent', FAILED: 'danger', IMPORTED: 'success' } },
  errorCount: {
    render: (v: unknown) => (Number(v) > 0 ? <span className="text-danger">{String(v)}</span> : String(v ?? 0)),
  },
} satisfies Record<string, ColumnOverride>

export interface BankImportHistoryDrawerProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 点开某条导入记录(记录抽屉叠在历史抽屉之上,关掉回到列表) */
  onOpenRecord: (id: string) => void
  /** 外部变更(新解析/导入完成)后自增,触发列表重取 */
  reloadKey: number
}

/** 导入历史抽屉:导入记录列表,查看/删除入口(能开此抽屉即持导入权限,按钮不再单独门控) */
export function BankImportHistoryDrawer({ isOpen, onOpenChange, onOpenRecord, reloadKey }: BankImportHistoryDrawerProps) {
  const [deleteAsk, setDeleteAsk] = useState<{ row: Row; ctx: ActionContext } | null>(null)
  const [running, setRunning] = useState(false)

  const confirmDelete = async () => {
    if (!deleteAsk) return
    setRunning(true)
    try {
      const data = await gqlFetch<{ destroyAccBankImport: { errors: { message: string }[] | null } }>(
        DESTROY_BANK_IMPORT,
        { id: deleteAsk.row.id }
      )
      throwOnErrors(data.destroyAccBankImport.errors)
      toast.success('导入记录已删除')
      deleteAsk.ctx.refetch()
      setDeleteAsk(null)
    } catch (e) {
      toast.danger('删除失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Sheet isOpen={isOpen} onOpenChange={onOpenChange} placement="right">
        <Sheet.Backdrop>
          <Sheet.Content className="w-full lg:w-[880px]">
            <Sheet.Dialog className="h-full" aria-label="导入历史">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>导入历史</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body>
                <SynieDataGrid
                  key={reloadKey}
                  resource="accBankImports"
                  columns={GRID_COLUMNS}
                  overrides={GRID_OVERRIDES}
                  defaultSort={{ column: 'insertedAt', direction: 'descending' }}
                  onView={(row) => onOpenRecord(row.id)}
                  rowActions={[
                    {
                      key: 'delete',
                      label: '删除',
                      isDanger: true,
                      onAction: (row, ctx) => {
                        // 后端同样拒绝,这里预检省一次往返
                        if (row.status === 'IMPORTED') {
                          toast.danger('已导入的记录不可删除')
                          return
                        }
                        setDeleteAsk({ row, ctx })
                      },
                    },
                  ]}
                />
              </Sheet.Body>
              <Sheet.Footer>
                <Sheet.Close>
                  <Button variant="secondary">关闭</Button>
                </Sheet.Close>
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>

      <AlertDialog.Backdrop isOpen={deleteAsk !== null} onOpenChange={(open) => !open && setDeleteAsk(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="删除导入记录">
            {deleteAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>删除这条导入记录?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>导入记录与其全部导入行将一并删除(未导入,不影响银行流水),此操作不可撤销。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={running}>
                    取消
                  </Button>
                  <Button variant="danger" isPending={running} onPress={confirmDelete}>
                    删除
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
