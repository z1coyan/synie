import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import { DESTROY_IMPORT_ITEM, IMPORT_BANK_IMPORT, UPDATE_IMPORT_ITEM, throwOnErrors } from './mutations'

// 表格列是白名单子集(对方账号/备注不进表格),行编辑抽屉走 rowId 自查完整记录
const ITEM_COLUMNS = ['rowNo', 'occurredAt', 'income', 'expense', 'balance', 'counterpartyName', 'summary', 'error']

export interface BankImportRecordDrawerProps {
  /** 要查看的导入记录 id;null 关闭 */
  importId: string | null
  onOpenChange: (open: boolean) => void
  /** 导入执行成功后回调(页面刷新流水表格与导入历史) */
  onImported: () => void
}

/**
 * 导入记录抽屉(view 态,解析后即锁定):头字段 + 导入行表格。
 * parsed 态可改/删行(保存即持久化,后端顺手清行错误)、footer 出「导入」主按钮;
 * imported 态整体只读;failed 态展示失败原因、无行区。
 */
export function BankImportRecordDrawer({ importId, onOpenChange, onImported }: BankImportRecordDrawerProps) {
  const queryClient = useQueryClient()
  // 行表格重挂键:行改删后自增刷新;头部聚合(行数/错误行数)靠失效 rowById 缓存刷新
  const [itemsKey, setItemsKey] = useState(0)
  const [itemDrawer, setItemDrawer] = useState<{ mode: DrawerMode; row: Row } | null>(null)
  const [deleteAsk, setDeleteAsk] = useState<Row | null>(null)
  const [importAsk, setImportAsk] = useState<Row | null>(null)
  const [running, setRunning] = useState(false)

  const refreshRecord = () => {
    queryClient.invalidateQueries({ queryKey: ['rowById', 'accBankImports'] })
    setItemsKey((k) => k + 1)
  }

  const confirmDeleteItem = async () => {
    if (!deleteAsk) return
    setRunning(true)
    try {
      const data = await gqlFetch<{ destroyAccBankImportItem: { errors: { message: string }[] | null } }>(
        DESTROY_IMPORT_ITEM,
        { id: deleteAsk.id }
      )
      throwOnErrors(data.destroyAccBankImportItem.errors)
      toast.success(`第 ${deleteAsk.rowNo} 行已删除`)
      setDeleteAsk(null)
      refreshRecord()
    } catch (e) {
      toast.danger('删除失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  const confirmImport = async () => {
    if (!importAsk) return
    setRunning(true)
    try {
      const data = await gqlFetch<{ importAccBankImport: { errors: { message: string }[] | null } }>(
        IMPORT_BANK_IMPORT,
        { id: importAsk.id }
      )
      throwOnErrors(data.importAccBankImport.errors)
      toast.success(`已导入 ${importAsk.itemCount as number} 条银行流水`)
      setImportAsk(null)
      refreshRecord()
      onImported()
    } catch (e) {
      toast.danger('导入失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <SynieRecordDrawer
        resource="accBankImports"
        label="流水导入"
        mode="view"
        isOpen={importId !== null}
        onOpenChange={onOpenChange}
        rowId={importId ?? undefined}
        contentClassName="w-full lg:w-[880px]"
        fields={{
          companyId: { order: 0, cols: 6 },
          bankAccountId: { order: 1, cols: 6 },
          templateId: { order: 2, cols: 6 },
          fileId: { order: 3, cols: 6 },
          status: { order: 4, cols: 4 },
          itemCount: { order: 5, cols: 4 },
          errorCount: {
            order: 6,
            cols: 4,
            render: (v) => (Number(v) > 0 ? <span className="text-danger">{String(v)}</span> : String(v ?? 0)),
          },
          error: {
            order: 7,
            // 仅解析失败的记录有内容,常态不占版面
            visible: (values) => values.status === 'FAILED',
            render: (v) => <span className="text-danger">{String(v ?? '')}</span>,
          },
          createdById: { order: 8, cols: 6 },
          importedById: { order: 9, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          importedAt: { order: 10, cols: 6, visible: (values) => values.status === 'IMPORTED' },
        }}
        extraContent={(_mode, row) => {
          if (!row || row.status === 'FAILED') return null
          const editable = row.status === 'PARSED'
          return (
            <div className="flex flex-col gap-2">
              <span className="text-sm text-muted">
                导入行{editable && ',导入前可在行操作里修正或删除错误行'}
              </span>
              <SynieDataGrid
                key={itemsKey}
                resource="accBankImportItems"
                columns={ITEM_COLUMNS}
                fixedFilter={{ importId: { eq: row.id } }}
                defaultSort={{ column: 'rowNo', direction: 'ascending' }}
                overrides={{
                  rowNo: { width: 72 },
                  error: {
                    render: (v) => (v ? <span className="text-danger">{String(v)}</span> : null),
                  },
                }}
                onView={(item) => setItemDrawer({ mode: 'view', row: item })}
                rowActions={
                  editable
                    ? [
                        { key: 'edit', label: '编辑', onAction: (item) => setItemDrawer({ mode: 'edit', row: item }) },
                        { key: 'delete', label: '删除', isDanger: true, onAction: (item) => setDeleteAsk(item) },
                      ]
                    : []
                }
              />
            </div>
          )
        }}
        footerActions={(_mode, row) => {
          if (!row || row.status !== 'PARSED') return null
          const blocked = Number(row.errorCount) > 0 || Number(row.itemCount) === 0
          return (
            <Button isDisabled={blocked} onPress={() => setImportAsk(row)}>
              导入({String(row.itemCount ?? 0)} 行)
            </Button>
          )
        }}
      />

      {/* 行查看/编辑:表格列不全,rowId 自查;保存即持久化(错误状态要实时回显,不攒批) */}
      <SynieRecordDrawer
        resource="accBankImportItems"
        label="导入行"
        mode={itemDrawer?.mode ?? 'view'}
        isOpen={itemDrawer !== null}
        onOpenChange={(open) => !open && setItemDrawer(null)}
        rowId={itemDrawer?.row.id}
        contentClassName="w-full lg:w-[480px]"
        exclude={['importId', 'companyId', 'transactionId']}
        fields={{
          rowNo: { edit: 'readOnly' },
          error: {
            edit: 'readOnly',
            visible: (values) => values.error != null && values.error !== '',
            render: (v) => <span className="text-danger">{String(v ?? '')}</span>,
          },
          occurredAt: { required: true },
          income: { cols: 6, placeholder: '与支出二填一', effects: (v) => (v ? { expense: null } : undefined) },
          expense: { cols: 6, placeholder: '与收入二填一', effects: (v) => (v ? { income: null } : undefined) },
          counterpartyName: { cols: 6 },
          counterpartyAccount: { cols: 6 },
        }}
        onEdit={
          itemDrawer?.mode === 'view'
            ? () => setItemDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        onSubmit={async (values) => {
          // error 是 readOnly 展示字段,collectValues 不会带上;后端保存通过即清行错误
          const data = await gqlFetch<{ updateAccBankImportItem: { errors: { message: string }[] | null } }>(
            UPDATE_IMPORT_ITEM,
            { id: itemDrawer!.row.id, input: values }
          )
          throwOnErrors(data.updateAccBankImportItem.errors)
          toast.success('导入行已保存')
          refreshRecord()
        }}
      />

      <AlertDialog.Backdrop isOpen={deleteAsk !== null} onOpenChange={(open) => !open && setDeleteAsk(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="删除导入行">
            {deleteAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>删除第 {String(deleteAsk.rowNo)} 行?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>删除后该行不会进入银行流水;文件里的合计行、非流水行可以这样剔除。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={running}>
                    取消
                  </Button>
                  <Button variant="danger" isPending={running} onPress={confirmDeleteItem}>
                    删除
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={importAsk !== null} onOpenChange={(open) => !open && setImportAsk(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" aria-label="执行导入">
            {importAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>导入 {String(importAsk.itemCount)} 行流水?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>确认后将按导入行创建银行流水,导入记录转为只读,此操作不可撤销。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={running}>
                    取消
                  </Button>
                  <Button isPending={running} onPress={confirmImport}>
                    确认导入
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
