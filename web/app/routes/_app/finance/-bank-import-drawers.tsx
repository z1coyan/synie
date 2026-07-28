import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import { DropZone, Sheet } from '@heroui-pro/react'
import { uploadFile } from '~/lib/files'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import {
  bankImportClient,
  bankImportItemClient,
  importBankImport,
  type BankImportRow,
} from '~/lib/resources/finance-operations'

const historyColumns = [
  'companyId',
  'bankAccountId',
  'templateId',
  'status',
  'itemCount',
  'errorCount',
  'createdById',
  'insertedAt',
]
const itemColumns = [
  'rowNo',
  'occurredAt',
  'income',
  'expense',
  'balance',
  'counterpartyName',
  'summary',
  'error',
]

interface Props {
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
  historyOpen: boolean
  onHistoryOpenChange: (open: boolean) => void
  historyKey: number
  importId: string | null
  onImportIdChange: (id: string | null) => void
  onChanged: () => void
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FinanceBankImportDrawers(props: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [itemDrawer, setItemDrawer] = useState<{
    mode: DrawerMode
    row: Row
  } | null>(null)
  const [deleteBatch, setDeleteBatch] = useState<Row | null>(null)
  const [deleteItem, setDeleteItem] = useState<Row | null>(null)
  const [importBatch, setImportBatch] = useState<Row | null>(null)
  const [running, setRunning] = useState(false)
  const [itemsKey, setItemsKey] = useState(0)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (props.createOpen) setFile(null)
  }, [props.createOpen])

  const refreshRecord = () => {
    queryClient.invalidateQueries({
      queryKey: ['rowById', 'accBankImports'],
    })
    setItemsKey((key) => key + 1)
  }

  const pickFile = (candidate: File) => {
    const name = candidate.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
      toast.danger('仅支持 Excel 文件(xlsx / xls)')
      return
    }
    setFile(candidate)
  }

  return (
    <>
      <SynieRecordDrawer
        resource="accBankImports"
        client={bankImportClient}
        label="流水导入"
        mode="create"
        isOpen={props.createOpen}
        onOpenChange={props.onCreateOpenChange}
        contentClassName="w-full lg:w-[720px]"
        submitLabel="解析"
        exclude={[
          'status',
          'error',
          'importedAt',
          'importedById',
          'createdById',
          'fileId',
          'itemCount',
          'errorCount',
        ]}
        fields={{
          companyId: {
            required: true,
            order: -1,
            effects: () => ({ bankAccountId: null, templateId: null }),
          },
          bankAccountId: {
            order: 1,
            required: true,
            effects: () => ({ templateId: null }),
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = values.companyId as string | null
              return (
                <RemoteSelect
                  resource="accBankAccounts"
                  label="银行账户"
                  labelField="alias"
                  searchFields={['alias', 'accountNo']}
                  placeholder={companyId ? '选择账户…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={onChange}
                  isDisabled={isDisabled || !companyId}
                  filterState={{
                    companyId: { kind: 'fk', values: [companyId!], labels: [] },
                    active: { kind: 'bool', eq: true },
                  }}
                />
              )
            },
          },
          templateId: {
            order: 2,
            required: true,
            input: ({ value, onChange, isDisabled, values }) => {
              const bankAccountId = values.bankAccountId as string | null
              return (
                <RemoteSelect
                  resource="accBankImportTemplates"
                  label="导入模板"
                  labelField="name"
                  searchFields={['name']}
                  placeholder={
                    bankAccountId ? '选择该账户的导入模板…' : '先选择银行账户'
                  }
                  value={value == null ? null : String(value)}
                  onChange={onChange}
                  isDisabled={isDisabled || !bankAccountId}
                  filterState={{
                    bankAccountId: { kind: 'fk', values: [bankAccountId!], labels: [] },
                  }}
                />
              )
            },
          },
        }}
        extraContent={() => (
          <DropZone>
            <DropZone.Area
              onDrop={async (event) => {
                for (const item of event.items) {
                  if (item.kind !== 'file') continue
                  pickFile(await item.getFile())
                  return
                }
              }}
            >
              <DropZone.Icon />
              <DropZone.Label>拖拽银行导出文件到此处,或点击选择</DropZone.Label>
              <DropZone.Description>
                支持 xlsx / xls;列布局须与所选导入模板一致
              </DropZone.Description>
              <DropZone.Trigger>选择文件</DropZone.Trigger>
            </DropZone.Area>
            <DropZone.Input
              accept=".xlsx,.xls"
              onSelect={(files) => files[0] && pickFile(files[0])}
            />
            {file && (
              <DropZone.FileList>
                <DropZone.FileItem status="complete">
                  <DropZone.FileInfo>
                    <DropZone.FileName>{file.name}</DropZone.FileName>
                    <DropZone.FileMeta>{formatFileSize(file.size)}</DropZone.FileMeta>
                  </DropZone.FileInfo>
                  <DropZone.FileRemoveTrigger
                    aria-label={`移除 ${file.name}`}
                    onPress={() => setFile(null)}
                  />
                </DropZone.FileItem>
              </DropZone.FileList>
            )}
          </DropZone>
        )}
        onSubmit={async (values) => {
          if (!file) throw new Error('请上传导入文件(xlsx / xls)')
          // 文件上传与业务记录创建保持旧契约的非原子边界。
          const uploaded = await uploadFile(file)
          const result = (await bankImportClient.create({
            ...values,
            fileId: uploaded.file.id,
          })) as BankImportRow
          props.onChanged()
          props.onImportIdChange(result.id)
          if (result.status === 'FAILED') {
            toast.danger('解析失败', {
              description: result.error ?? '请检查文件与模板配置',
            })
          } else if ((result.errorCount ?? 0) > 0) {
            toast.warning(
              `解析完成:共 ${(result.itemCount ?? 0)} 行,${(result.errorCount ?? 0)} 行有错误`,
            )
          } else {
            toast.success(`解析完成:共 ${(result.itemCount ?? 0)} 行,可以导入`)
          }
        }}
      />

      <Sheet
        isOpen={props.historyOpen}
        onOpenChange={props.onHistoryOpenChange}
        placement="right"
      >
        <Sheet.Backdrop>
          <Sheet.Content className="w-full lg:w-[880px]">
            <Sheet.Dialog className="h-full" aria-label="导入历史">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>导入历史</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body>
                <SynieDataGrid
                  key={props.historyKey}
                  resource="accBankImports"
                  client={bankImportClient}
                  columns={historyColumns}
                  defaultSort={{
                    column: 'insertedAt',
                    direction: 'descending',
                  }}
                  onView={(row) => props.onImportIdChange(row.id)}
                  rowActions={[
                    {
                      key: 'delete',
                      label: '删除',
                      isDanger: true,
                      onAction: (row) => {
                        if (row.status === 'IMPORTED') {
                          toast.danger('已导入的记录不可删除')
                        } else {
                          setDeleteBatch(row)
                        }
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

      <SynieRecordDrawer
        resource="accBankImports"
        client={bankImportClient}
        label="流水导入"
        mode="view"
        isOpen={props.importId !== null}
        onOpenChange={(open) => !open && props.onImportIdChange(null)}
        rowId={props.importId ?? undefined}
        contentClassName="w-full lg:w-[880px]"
        fields={{
          error: {
            visible: (values) => values.status === 'FAILED',
            render: (value) => (
              <span className="text-danger">{String(value ?? '')}</span>
            ),
          },
        }}
        extraContent={(_mode, row) =>
          !row || row.status === 'FAILED' ? null : (
            <SynieDataGrid
              key={itemsKey}
              resource="accBankImportItems"
              client={bankImportItemClient}
              columns={itemColumns}
              fixedFilter={{
                importId: {
                  kind: 'fk',
                  values: [row.id],
                  labels: [row.id],
                },
              }}
              defaultSort={{ column: 'rowNo', direction: 'ascending' }}
              onView={(item) => setItemDrawer({ mode: 'view', row: item })}
              rowActions={
                row.status === 'PARSED'
                  ? [
                      {
                        key: 'edit',
                        label: '编辑',
                        onAction: (item) =>
                          setItemDrawer({ mode: 'edit', row: item }),
                      },
                      {
                        key: 'delete',
                        label: '删除',
                        isDanger: true,
                        onAction: setDeleteItem,
                      },
                    ]
                  : []
              }
            />
          )
        }
        footerActions={(_mode, row) =>
          row?.status === 'PARSED' ? (
            <Button
              isDisabled={
                Number(row.errorCount) > 0 || Number(row.itemCount) === 0
              }
              onPress={() => setImportBatch(row)}
            >
              导入({String(row.itemCount ?? 0)} 行)
            </Button>
          ) : null
        }
      />

      <SynieRecordDrawer
        resource="accBankImportItems"
        client={bankImportItemClient}
        label="导入行"
        mode={itemDrawer?.mode ?? 'view'}
        isOpen={itemDrawer !== null}
        onOpenChange={(open) => !open && setItemDrawer(null)}
        rowId={itemDrawer?.row.id}
        exclude={['importId', 'companyId', 'transactionId']}
        fields={{
          rowNo: { edit: 'readOnly' },
          error: { edit: 'readOnly' },
          occurredAt: { required: true },
          income: {
            cols: 6,
            effects: (value) => (value ? { expense: null } : undefined),
          },
          expense: {
            cols: 6,
            effects: (value) => (value ? { income: null } : undefined),
          },
        }}
        onEdit={() =>
          setItemDrawer((current) =>
            current ? { ...current, mode: 'edit' } : current,
          )
        }
        onSubmit={async (values) => {
          await bankImportItemClient.update(itemDrawer!.row.id, values)
          toast.success('导入行已保存')
          refreshRecord()
        }}
      />

      <AlertDialog.Backdrop
        isOpen={deleteBatch !== null}
        onOpenChange={(open) => !open && setDeleteBatch(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog aria-label="删除导入记录">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除这条导入记录?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>导入行将一并删除,此操作不可撤销。</AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={running}>
                取消
              </Button>
              <Button
                variant="danger"
                isPending={running}
                onPress={async () => {
                  if (!deleteBatch) return
                  setRunning(true)
                  try {
                    await bankImportClient.delete(deleteBatch.id)
                    setDeleteBatch(null)
                    props.onChanged()
                    toast.success('导入记录已删除')
                  } catch (error) {
                    toast.danger('删除失败', {
                      description: (error as Error).message,
                    })
                  } finally {
                    setRunning(false)
                  }
                }}
              >
                删除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop
        isOpen={deleteItem !== null}
        onOpenChange={(open) => !open && setDeleteItem(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog aria-label="删除导入行">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>
                删除第 {String(deleteItem?.rowNo ?? '')} 行?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={running}>
                取消
              </Button>
              <Button
                variant="danger"
                isPending={running}
                onPress={async () => {
                  if (!deleteItem) return
                  setRunning(true)
                  try {
                    await bankImportItemClient.delete(deleteItem.id)
                    setDeleteItem(null)
                    refreshRecord()
                  } finally {
                    setRunning(false)
                  }
                }}
              >
                删除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop
        isOpen={importBatch !== null}
        onOpenChange={(open) => !open && setImportBatch(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog aria-label="执行导入">
            <AlertDialog.Header>
              <AlertDialog.Icon status="accent" />
              <AlertDialog.Heading>
                导入 {String(importBatch?.itemCount ?? 0)} 行流水?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              确认后导入记录转为只读,此操作不可撤销。
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={running}>
                取消
              </Button>
              <Button
                isPending={running}
                onPress={async () => {
                  if (!importBatch) return
                  setRunning(true)
                  try {
                    await importBankImport(importBatch.id)
                    setImportBatch(null)
                    refreshRecord()
                    props.onChanged()
                    toast.success('银行流水已导入')
                  } catch (error) {
                    toast.danger('导入失败', {
                      description: (error as Error).message,
                    })
                  } finally {
                    setRunning(false)
                  }
                }}
              >
                确认导入
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
