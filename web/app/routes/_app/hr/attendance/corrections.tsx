import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { parseTime } from '@internationalized/date'
import { Button, DateField, Label, TimeField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/hr/attendance/corrections')({
  component: AttendanceCorrectionsPage,
})

const CREATE_CORRECTION = `
  mutation ($input: CreateHrAttendanceCorrectionInput!) {
    createHrAttendanceCorrection(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_CORRECTION = `
  mutation ($id: ID!, $input: UpdateHrAttendanceCorrectionInput!) {
    updateHrAttendanceCorrection(id: $id, input: $input) { result { id } errors { message } }
  }
`

// times 数组列经表格行/表单草稿会退化为逗号串,两种形态都归一为 HH:MM:SS 数组
const parseTimes = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((t) => padTime(String(t)))
  if (typeof v === 'string' && v.trim() !== '')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(padTime)
  return []
}

// "HH:MM" → "HH:MM:SS"(TimeField/@internationalized 的 Time.toString 可能省秒)
const padTime = (t: string) => (t.length === 5 ? `${t}:00` : t)

const timesPreview = (v: unknown) => parseTimes(v).map((t) => t.slice(0, 5)).join('、')

const GRID_COLUMNS = ['employeeId', 'date', 'times', 'note', 'createdById', 'insertedAt']

const GRID_OVERRIDES = {
  times: { render: (v) => timesPreview(v) || null },
} satisfies Record<string, ColumnOverride>

// 补卡时刻编辑器:一行一个 TimeField,增删行;值形态是 HH:MM:SS 数组
function TimesEditor(props: { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }) {
  const times = parseTimes(props.value)

  const setAt = (i: number, t: string | null) => {
    const next = [...times]
    if (t == null) next.splice(i, 1)
    else next[i] = t
    props.onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>补卡时刻</Label>
      {times.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <TimeField
            hourCycle={24}
            aria-label={`补卡时刻 ${i + 1}`}
            value={parseTime(t)}
            onChange={(v) => v && setAt(i, padTime(v.toString()))}
            isDisabled={props.isDisabled}
            className="flex-1"
          >
            <DateField.Group fullWidth>
              <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            </DateField.Group>
          </TimeField>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={props.isDisabled || times.length <= 1}
            onPress={() => setAt(i, null)}
          >
            移除
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        isDisabled={props.isDisabled || times.length >= 20}
        onPress={() => props.onChange([...times, '08:00:00'])}
      >
        添加时刻
      </Button>
    </div>
  )
}

function AttendanceCorrectionsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  // 补卡增删改都会触发后端重算,日考勤一并失效
  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendanceCorrections'] })
    queryClient.invalidateQueries({ queryKey: ['rowById', 'hrAttendanceCorrections'] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrAttendanceDays'] })
    queryClient.invalidateQueries({ queryKey: ['rowById', 'hrAttendanceDays'] })
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        漏打卡/考勤机故障的修正入口:按人按天录虚拟卡,与真实打卡合并参与计算;保存/删除即自动重算当天。原始打卡永不修改,一人一天一单,同日再补请编辑原单。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="hrAttendanceCorrections"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'insertedAt', direction: 'descending' }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        resource="hrAttendanceCorrections"
        label="补卡单"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        exclude={['createdById']}
        fields={{
          // 关系属性在 meta 列序靠后,表单里员工是第一输入项
          employeeId: { required: true, order: -1 },
          date: { required: true },
          times: {
            required: true,
            defaultValue: ['08:00:00'],
            render: (v) => timesPreview(v) || '—',
            input: ({ value, onChange, isDisabled }) => (
              <TimesEditor value={value} onChange={onChange} isDisabled={isDisabled} />
            ),
          },
          note: { placeholder: '如 考勤机故障、外出办事漏打' },
        }}
        onSubmit={async (values, mode) => {
          const times = parseTimes(values.times)
          if (times.length === 0) throw new Error('至少需要一个补卡时刻')
          const input = { ...values, times }

          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{
              createHrAttendanceCorrection: { errors: { message: string }[] | null }
            }>(CREATE_CORRECTION, { input })
            errors = data.createHrAttendanceCorrection.errors
          } else {
            const data = await gqlFetch<{
              updateHrAttendanceCorrection: { errors: { message: string }[] | null }
            }>(UPDATE_CORRECTION, { id: drawer!.row!.id, input })
            errors = data.updateHrAttendanceCorrection.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '补卡单已保存,当天日考勤已重算' : '补卡单已更新,当天日考勤已重算')
          invalidateAll()
        }}
      />
    </>
  )
}
