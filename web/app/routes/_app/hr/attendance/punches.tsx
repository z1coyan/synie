import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/hr/attendance/punches')({
  component: AttendancePunchesPage,
})

// 原始打卡事实台账:员工 fk + 原始编号 + 时刻 + 来源批次 fk,全部只读
// (导入是唯一写入口,无新增/编辑/删除;导错走导入记录 tab 整批撤销)
const GRID_COLUMNS = ['employeeId', 'attendanceNo', 'punchedAt', 'importId']

const GRID_OVERRIDES = {
  // 打卡是到秒的原始事实,时刻完整展示
  punchedAt: {
    render: (v: unknown) =>
      v == null || v === ''
        ? null
        : new Date(String(v)).toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
  },
  importId: { label: '导入批次' },
} satisfies Record<string, ColumnOverride>

function AttendancePunchesPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <p className="text-sm text-ink-500">
        考勤机原始打卡记录,由 .dat 导入产生、不可修改;同一员工同一时刻仅存一条,连按考勤机的隔秒记录原样保留。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="hrAttendancePunches"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'punchedAt', direction: 'descending' }}
          onView={(row) => setViewRow(row)}
        />
      </div>

      <SynieRecordDrawer
        resource="hrAttendancePunches"
        label="打卡记录"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        // 表格列是白名单子集,行数据不全;走 rowId 自查完整记录
        rowId={viewRow?.id}
      />
    </>
  )
}
