import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, Checkbox, toast } from '@heroui/react'
import { DropZone } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { uploadFile } from '~/lib/files'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

/** 考勤导入的 GraphQL 操作与结果形状 */

export interface ParseResult {
  id: string
  status: string
  error: string | null
  totalRows: number | null
  matchedRows: number | null
  unmatchedRows: number | null
}

const CREATE_ATTENDANCE_IMPORT = `
  mutation ($input: CreateHrAttendanceImportInput!) {
    createHrAttendanceImport(input: $input) {
      result { id status error totalRows matchedRows unmatchedRows }
      errors { message }
    }
  }
`

const IMPORT_ATTENDANCE_IMPORT = `
  mutation ($id: ID!, $input: ImportHrAttendanceImportInput) {
    importHrAttendanceImport(id: $id, input: $input) {
      result { id importedCount skippedExistingRows skippedUnmatchedRows autoCreatedCount }
      errors { message }
    }
  }
`

export const DESTROY_ATTENDANCE_IMPORT = `
  mutation ($id: ID!) {
    destroyHrAttendanceImport(id: $id) { errors { message } }
  }
`

/** AshGraphql mutation 的业务错误不走异常通道,统一在此抛出交给调用方 toast */
export function throwOnErrors(errors: { message: string }[] | null | undefined): void {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface AttendanceImportCreateDrawerProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 解析(create)成功后回调,页面据此打开批次抽屉看摘要 */
  onParsed: (result: ParseResult) => void
}

/**
 * 新增导入抽屉:仅上传 .dat 文件,「解析预览」即提交——后端 create 同步解析出
 * 摘要(总行/已匹配/未匹配编号清单),暂存行不落库,成败都落批次记录。
 */
export function AttendanceImportCreateDrawer({ isOpen, onOpenChange, onParsed }: AttendanceImportCreateDrawerProps) {
  const [file, setFile] = useState<File | null>(null)

  // 每次打开清残留的上次选择
  useEffect(() => {
    if (isOpen) setFile(null)
  }, [isOpen])

  const pickFile = (candidate: File) => {
    if (!candidate.name.toLowerCase().endsWith('.dat')) {
      toast.danger('仅支持考勤机导出的 .dat 文件')
      return
    }
    setFile(candidate)
  }

  return (
    <SynieRecordDrawer
      resource="hrAttendanceImports"
      label="考勤导入"
      mode="create"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      contentClassName="w-full lg:w-[560px]"
      submitLabel="解析预览"
      // 摘要/结果字段全部系统维护,create 态只收文件
      exclude={[
        'status',
        'error',
        'totalRows',
        'badRows',
        'dupRows',
        'matchedRows',
        'unmatchedRows',
        'unmatchedDetail',
        'importedCount',
        'skippedExistingRows',
        'skippedUnmatchedRows',
        'autoCreatedCount',
        'importedAt',
        'createdById',
        'importedById',
        'fileId',
        'punchCount',
      ]}
      extraContent={(mode) =>
        mode === 'create' ? (
          <DropZone>
            <DropZone.Area
              onDrop={async (e) => {
                for (const item of e.items) {
                  if (item.kind === 'file') {
                    pickFile(await item.getFile())
                    return
                  }
                }
              }}
            >
              <DropZone.Icon />
              <DropZone.Label>拖拽考勤机导出文件到此处,或点击选择</DropZone.Label>
              <DropZone.Description>ZKTeco .dat 打卡记录:每行「考勤机编号 + 打卡时间」</DropZone.Description>
              <DropZone.Trigger>选择文件</DropZone.Trigger>
            </DropZone.Area>
            <DropZone.Input accept=".dat" onSelect={(list) => list[0] && pickFile(list[0])} />
            {file && (
              <DropZone.FileList>
                <DropZone.FileItem status="complete">
                  <DropZone.FileFormatIcon color="blue" format="DAT" />
                  <DropZone.FileInfo>
                    <DropZone.FileName>{file.name}</DropZone.FileName>
                    <DropZone.FileMeta>{formatFileSize(file.size)}</DropZone.FileMeta>
                  </DropZone.FileInfo>
                  <DropZone.FileRemoveTrigger aria-label={`移除 ${file.name}`} onPress={() => setFile(null)} />
                </DropZone.FileItem>
              </DropZone.FileList>
            )}
          </DropZone>
        ) : null
      }
      onSubmit={async () => {
        if (!file) throw new Error('请上传考勤机导出的 .dat 文件')

        // 先传文件字节(REST),拿到 fileId 再建批次;create 失败会留下孤儿文件,可接受(照银行导入)
        const uploaded = await uploadFile(file)

        const data = await gqlFetch<{
          createHrAttendanceImport: { result: ParseResult | null; errors: { message: string }[] | null }
        }>(CREATE_ATTENDANCE_IMPORT, { input: { fileId: uploaded.file.id } })
        throwOnErrors(data.createHrAttendanceImport.errors)

        const result = data.createHrAttendanceImport.result!
        if (result.status === 'FAILED') {
          // 解析失败也算批次建成:不抛错(抛错不关抽屉且暗示可重试),开批次抽屉看原因
          toast.danger('解析失败', { description: result.error ?? '请检查文件内容' })
        } else if ((result.unmatchedRows ?? 0) > 0) {
          toast.warning(`解析完成:共 ${result.totalRows} 行,${result.unmatchedRows} 行未匹配到员工`, {
            description: '可先去员工档案补考勤机编号,或执行导入时勾选自动创建',
          })
        } else {
          toast.success(`解析完成:共 ${result.totalRows} 行,可导入 ${result.matchedRows} 行`)
        }
        onParsed(result)
      }}
    />
  )
}

export interface AttendanceImportRecordDrawerProps {
  /** 要查看的批次 id;null 关闭 */
  importId: string | null
  onOpenChange: (open: boolean) => void
  /** 导入执行成功后回调(页面刷新打卡台账与批次列表) */
  onImported: () => void
}

/**
 * 批次抽屉(view 态):解析摘要 + 执行导入动线。parsed 态 footer 出
 * 「自动创建不存在的员工」勾选(须兼有员工新增权限,无权禁用)与「执行导入」
 * 主按钮;imported 态展示执行结果;failed 态展示失败原因。
 */
export function AttendanceImportRecordDrawer({ importId, onOpenChange, onImported }: AttendanceImportRecordDrawerProps) {
  const queryClient = useQueryClient()
  const [autoCreate, setAutoCreate] = useState(false)
  const [importAsk, setImportAsk] = useState<{ id: string; matched: number; unmatched: number } | null>(null)
  const [running, setRunning] = useState(false)

  // 自动建员工是真实的员工创建,按员工资源 create 能力门控(后端同样 fail-closed 兜底)
  const employeeMeta = useGridMeta('hrEmployees')
  const canCreateEmployee = (employeeMeta.data?.capabilities ?? []).includes('create')

  // 每次换批次重置勾选
  useEffect(() => {
    setAutoCreate(false)
  }, [importId])

  const confirmImport = async () => {
    if (!importAsk) return
    setRunning(true)
    try {
      const data = await gqlFetch<{
        importHrAttendanceImport: {
          result: {
            importedCount: number
            skippedExistingRows: number
            skippedUnmatchedRows: number
            autoCreatedCount: number
          } | null
          errors: { message: string }[] | null
        }
      }>(IMPORT_ATTENDANCE_IMPORT, { id: importAsk.id, input: { autoCreateEmployees: autoCreate } })
      throwOnErrors(data.importHrAttendanceImport.errors)

      const r = data.importHrAttendanceImport.result!
      const skipped = [
        r.skippedExistingRows > 0 ? `跳过已存在 ${r.skippedExistingRows} 条` : null,
        r.skippedUnmatchedRows > 0 ? `跳过未匹配 ${r.skippedUnmatchedRows} 条` : null,
        r.autoCreatedCount > 0 ? `自动创建员工 ${r.autoCreatedCount} 名` : null,
      ]
        .filter(Boolean)
        .join(',')
      toast.success(`已导入 ${r.importedCount} 条打卡`, skipped ? { description: skipped } : undefined)

      setImportAsk(null)
      queryClient.invalidateQueries({ queryKey: ['rowById', 'hrAttendanceImports'] })
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
        resource="hrAttendanceImports"
        label="考勤导入"
        mode="view"
        isOpen={importId !== null}
        onOpenChange={onOpenChange}
        rowId={importId ?? undefined}
        contentClassName="w-full lg:w-[640px]"
        fields={{
          fileId: { order: 0, cols: 6 },
          status: { order: 1, cols: 6 },
          error: {
            order: 2,
            // 仅解析失败的批次有内容,常态不占版面
            visible: (values) => values.status === 'FAILED',
            render: (v) => <span className="text-danger">{String(v ?? '')}</span>,
          },
          totalRows: { order: 3, cols: 4 },
          matchedRows: { order: 4, cols: 4 },
          unmatchedRows: {
            order: 5,
            cols: 4,
            render: (v) => (Number(v) > 0 ? <span className="text-danger">{String(v)}</span> : String(v ?? 0)),
          },
          badRows: { order: 6, cols: 6, visible: (values) => values.status !== 'FAILED' },
          dupRows: { order: 7, cols: 6, visible: (values) => values.status !== 'FAILED' },
          unmatchedDetail: {
            order: 8,
            visible: (values) => Number(values.unmatchedRows) > 0,
            render: (v) => <span className="text-warning">{String(v ?? '')}</span>,
          },
          importedCount: { order: 9, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          skippedExistingRows: { order: 10, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          skippedUnmatchedRows: { order: 11, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          autoCreatedCount: { order: 12, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          createdById: { order: 13, cols: 6 },
          importedById: { order: 14, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          importedAt: { order: 15, cols: 6, visible: (values) => values.status === 'IMPORTED' },
          punchCount: { order: 16, cols: 6, visible: (values) => values.status === 'IMPORTED' },
        }}
        footerActions={(_mode, row) => {
          if (!row || row.status !== 'PARSED') return null
          const matched = Number(row.matchedRows ?? 0)
          const unmatched = Number(row.unmatchedRows ?? 0)
          // 勾选自动建后未匹配行也会导入;两者都为 0 就没有可导的行
          const importable = matched + (autoCreate ? unmatched : 0)
          return (
            <div className="flex w-full items-center justify-between gap-4">
              <Checkbox
                isSelected={autoCreate}
                isDisabled={!canCreateEmployee || unmatched === 0}
                onChange={(selected: boolean) => setAutoCreate(selected)}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  自动创建不存在的员工
                  {!canCreateEmployee && '(需员工新增权限)'}
                </Checkbox.Content>
              </Checkbox>
              <Button
                isDisabled={importable === 0}
                onPress={() => setImportAsk({ id: String(row.id), matched, unmatched })}
              >
                执行导入({importable} 行)
              </Button>
            </div>
          )
        }}
      />

      <AlertDialog.Backdrop isOpen={importAsk !== null} onOpenChange={(open) => !open && setImportAsk(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" aria-label="执行导入">
            {importAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>
                    导入 {importAsk.matched + (autoCreate ? importAsk.unmatched : 0)} 行打卡?
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  {autoCreate && importAsk.unmatched > 0 ? (
                    <p>未匹配编号将自动创建为姓名「[未知]」的员工(编号走员工编号规则),其打卡一并导入。</p>
                  ) : (
                    <p>
                      与已有打卡重复的行会静默跳过
                      {importAsk.unmatched > 0 && `;${importAsk.unmatched} 行未匹配员工将跳过`}。导错可删除批次整批撤销。
                    </p>
                  )}
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
