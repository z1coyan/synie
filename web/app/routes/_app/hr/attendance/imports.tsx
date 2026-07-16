import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { ActionContext, Row } from '~/components/synie-data-grid/types'
import {
  AttendanceImportCreateDrawer,
  AttendanceImportRecordDrawer,
  DESTROY_ATTENDANCE_IMPORT,
  throwOnErrors,
} from './-import-drawers'

export const Route = createFileRoute('/_app/hr/attendance/imports')({
  component: AttendanceImportsPage,
})

// 批次列表:文件 fk + 状态 + 解析/执行关键数,细项(坏行/重复/跳过明细)进批次抽屉
const GRID_COLUMNS = [
  'fileId',
  'status',
  'totalRows',
  'matchedRows',
  'unmatchedRows',
  'importedCount',
  'createdById',
  'insertedAt',
]

// 状态胶囊配色:已解析蓝、解析失败红、已导入绿(照银行导入)
const GRID_OVERRIDES = {
  status: { enumColors: { PARSED: 'accent', FAILED: 'danger', IMPORTED: 'success' } },
  unmatchedRows: {
    render: (v: unknown) => (Number(v) > 0 ? <span className="text-danger">{String(v)}</span> : String(v ?? 0)),
  },
} satisfies Record<string, ColumnOverride>

function AttendanceImportsPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const [recordId, setRecordId] = useState<string | null>(null)
  const [deleteAsk, setDeleteAsk] = useState<{ row: Row; ctx: ActionContext } | null>(null)
  const [running, setRunning] = useState(false)
  const queryClient = useQueryClient()

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendanceImports'] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendancePunches'] })
  }

  const confirmDelete = async () => {
    if (!deleteAsk) return
    setRunning(true)
    try {
      const data = await gqlFetch<{ destroyHrAttendanceImport: { errors: { message: string }[] | null } }>(
        DESTROY_ATTENDANCE_IMPORT,
        { id: deleteAsk.row.id }
      )
      throwOnErrors(data.destroyHrAttendanceImport.errors)
      toast.success(
        deleteAsk.row.status === 'IMPORTED' ? '批次已删除,其导入的打卡已整批撤销' : '批次已删除'
      )
      deleteAsk.ctx.refetch()
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendancePunches'] })
      setDeleteAsk(null)
    } catch (e) {
      toast.danger('删除失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        上传 ZKTeco 考勤机导出的 .dat 打卡文件:解析预览(未匹配编号先看清)→ 执行导入;导错删除批次即整批撤销。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="hrAttendanceImports"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'insertedAt', direction: 'descending' }}
          onView={(row) => setRecordId(String(row.id))}
          // 建批次走工具栏「导入」位:批次资源无独立权限码,按 hr.attendance_punch:import
          // 门控(grid_capabilities),语义也贴合「导入」动作
          onImport={() => setCreateOpen(true)}
          rowActions={[
            {
              key: 'delete',
              label: '删除/撤销',
              isDanger: true,
              capability: 'import',
              onAction: (row, ctx) => setDeleteAsk({ row, ctx }),
            },
          ]}
        />
      </div>

      <AttendanceImportCreateDrawer
        isOpen={createOpen}
        onOpenChange={setCreateOpen}
        onParsed={(result) => {
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendanceImports'] })
          setRecordId(result.id)
        }}
      />

      <AttendanceImportRecordDrawer
        importId={recordId}
        onOpenChange={(open) => !open && setRecordId(null)}
        onImported={invalidateAll}
      />

      <AlertDialog.Backdrop isOpen={deleteAsk !== null} onOpenChange={(open) => !open && setDeleteAsk(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]" aria-label="删除批次">
            {deleteAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>
                    {deleteAsk.row.status === 'IMPORTED' ? '撤销这个批次?' : '删除这条批次记录?'}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  {deleteAsk.row.status === 'IMPORTED' ? (
                    <p>
                      该批次导入的 {String(deleteAsk.row.importedCount ?? 0)}{' '}
                      条打卡将一并删除(整批撤销);文件本身保留,可重新导入。
                    </p>
                  ) : (
                    <p>该批次尚未导入打卡,删除只清理这条解析记录。</p>
                  )}
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={running}>
                    取消
                  </Button>
                  <Button variant="danger" isPending={running} onPress={confirmDelete}>
                    {deleteAsk.row.status === 'IMPORTED' ? '撤销并删除' : '删除'}
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
