import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, ListBox, Select, toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import {
  SegmentsEditor,
  segmentsPreview,
  type NumberSegment,
} from '~/components/synie-numbering-segments/SegmentsEditor'
import { resourceLabel } from '~/components/synie-permission-sheet/permission-labels'
import {
  listNumberableResources,
  numberingCounterClient,
  numberingRuleClient,
} from '~/lib/resources/numbering'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/numbering')({
  component: NumberingPage,
})

function parseSegments(value: unknown): NumberSegment[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item !== 'string') return item as NumberSegment
      try {
        return JSON.parse(item) as NumberSegment
      } catch {
        return null
      }
    })
    .filter((segment): segment is NumberSegment => segment != null)
}

async function persistCounters(current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  for (const row of current) {
    const old = snapshot.find((item) => item.id === row.id)
    if (!old || String(old.value) === String(row.value)) continue
    try {
      await numberingCounterClient.update(row.id, { value: Number(row.value) })
    } catch (error) {
      errors.push(`${String(row.scopeKey)}:${(error as Error).message}`)
    }
  }
  return errors
}

const GRID_COLUMNS = ['resource', 'name', 'segments', 'perCompany', 'enabled']

const GRID_OVERRIDES = {
  resource: { render: (value) => resourceLabel(String(value ?? '')) },
  segments: {
    label: '规则预览',
    render: (value) => (
      <span className="font-mono text-xs">{segmentsPreview(parseSegments(value))}</span>
    ),
  },
} satisfies Record<string, ColumnOverride>

function NumberingPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [counters, setCounters] = useState<Row[]>([])
  const [countersSnapshot, setCountersSnapshot] = useState<Row[]>([])
  const queryClient = useQueryClient()
  const requestID = useRef(0)

  const numberables = useQuery({
    queryKey: ['numberableResources', numberingRuleClient.id],
    queryFn: listNumberableResources,
    staleTime: 5 * 60_000,
  })
  const fieldsFor = (prefix: unknown) =>
    numberables.data?.find((resource) => resource.prefix === prefix)?.fields ?? null

  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const currentRequest = ++requestID.current
    setDrawer({ mode, row })
    if (mode === 'create' || row == null) {
      setCounters([])
      setCountersSnapshot([])
      return
    }
    numberingCounterClient
      .query({
        limit: 200,
        offset: 0,
        fixedFilter: {
          ruleId: { kind: 'fk', values: [row.id], labels: [] },
        },
      })
      .then((result) => {
        if (currentRequest !== requestID.current) return
        setCounters(result.results)
        setCountersSnapshot(result.results)
      })
      .catch((error) => {
        if (currentRequest !== requestID.current) return
        toast.danger('计数器加载失败', { description: (error as Error).message })
        setCounters([])
        setCountersSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">编号规则</h1>
      <p className="mt-2 text-sm text-ink-500">
        单据自动编号:规则绑定单据,编号由「固定文本 + 单据字段 + 序号」拼装(序号只能一段,
        日期字段可选格式);单据保存时编号留空即自动取号。计数按「渲染后的文本 + 是否按公司」
        自然分组——日期变了序号自动从头计;计数器由取号自动创建,可在规则里调整当前序号。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysNumberingRules"
          client={numberingRuleClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
          rowActions={statusToggleActions({
            field: 'enabled',
            update: numberingRuleClient.update,
            onDone: () =>
              queryClient.invalidateQueries({
                queryKey: ['gridRows', numberingRuleClient.id, 'sysNumberingRules'],
              }),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource="sysNumberingRules"
        client={numberingRuleClient}
        label="编号规则"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          requestID.current++
          setDrawer(null)
          setCounters([])
          setCountersSnapshot([])
        }}
        row={drawer?.row}
        contentClassName="w-full lg:w-[640px]"
        exclude={['enabled']}
        fields={{
          resource: {
            required: true,
            edit: 'createOnly',
            effects: () => ({ segments: [] }),
            render: (value) => resourceLabel(String(value ?? '')),
            input: ({ value, onChange, isDisabled }) => (
              <Select
                isDisabled={isDisabled}
                isRequired
                placeholder="选择要自动编号的单据…"
                value={value == null ? null : String(value)}
                onChange={(selected) => onChange(selected)}
              >
                <Label>绑定单据</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {(numberables.data ?? []).map((resource) => {
                      const prefix = resource.prefix ?? resource.resource
                      return (
                        <ListBox.Item
                          key={prefix}
                          id={prefix}
                          textValue={resourceLabel(prefix)}
                        >
                          {resourceLabel(prefix)}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      )
                    })}
                  </ListBox>
                </Select.Popover>
              </Select>
            ),
          },
          name: { required: true, placeholder: '如 记账凭证编号' },
          segments: {
            required: true,
            normalize: parseSegments,
            render: (value) => (
              <span className="font-mono text-sm">
                {segmentsPreview(parseSegments(value)) || '—'}
              </span>
            ),
            input: ({ value, onChange, isDisabled, values }) => (
              <SegmentsEditor
                fields={fieldsFor(values.resource)}
                value={parseSegments(value)}
                onChange={onChange}
                isDisabled={isDisabled}
              />
            ),
          },
          perCompany: { defaultValue: true, cols: 6 },
        }}
        onEdit={() => setDrawer((current) => (current ? { ...current, mode: 'edit' } : current))}
        extraContent={(mode, row) =>
          row == null ? null : (
            <SynieEditableTable
              resource="sysNumberingCounters"
              client={numberingCounterClient}
              label="计数器"
              title="计数器(当前序号)"
              items={counters}
              onChange={setCounters}
              readOnly={mode === 'view'}
              canCreate={false}
              canDelete={false}
              exclude={['ruleId']}
              fields={{
                scopeKey: { edit: 'readOnly' },
                value: { required: true },
              }}
            />
          )
        }
        onSubmit={async (values, mode) => {
          const segments = parseSegments(values.segments)
          if (segments.length === 0 || segments.filter((segment) => segment.type === 'seq').length !== 1) {
            throw new Error('编号段不能为空,且必须恰好包含一个序号段')
          }
          const input = { ...values, segments }
          if (mode === 'create') {
            await numberingRuleClient.create(input)
            toast.success('编号规则已创建')
          } else {
            await numberingRuleClient.update(drawer!.row!.id, input)
            const counterErrors = await persistCounters(counters, countersSnapshot)
            if (counterErrors.length > 0) {
              toast.danger('规则已更新,但部分计数器保存失败', {
                description: counterErrors.join('; '),
              })
            } else {
              toast.success('编号规则已更新')
            }
          }
          await queryClient.invalidateQueries({
            queryKey: ['gridRows', numberingRuleClient.id, 'sysNumberingRules'],
          })
        }}
      />
    </>
  )
}
