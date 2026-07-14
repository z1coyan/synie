import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, ListBox, Select, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import {
  SegmentsEditor,
  segmentsPreview,
  type NumberSegment,
} from '~/components/synie-numbering-segments/SegmentsEditor'
import { resourceLabel } from '~/components/synie-permission-sheet/permission-labels'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/numbering')({
  component: NumberingPage,
})

const NUMBERABLE_QUERY = `
  query { numberableResources { prefix grid } }
`
const CREATE_RULE = `
  mutation ($input: CreateSysNumberingRuleInput!) {
    createSysNumberingRule(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_RULE = `
  mutation ($id: ID!, $input: UpdateSysNumberingRuleInput!) {
    updateSysNumberingRule(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_COUNTERS = `
  query ($ruleId: ID!) {
    sysNumberingCounters(filter: {ruleId: {eq: $ruleId}}, limit: 200, offset: 0) {
      results { id scopeKey value }
    }
  }
`
const UPDATE_COUNTER = `
  mutation ($id: ID!, $input: UpdateSysNumberingCounterInput!) {
    updateSysNumberingCounter(id: $id, input: $input) { result { id } errors { message } }
  }
`

interface NumberableResource {
  prefix: string
  grid: string
}

/**
 * segments 经 GraphQL 走 [JsonString!](每段一个 JSON 串);编辑草稿里是对象数组;
 * RecordDrawer 初值把串数组 String() 成逗号拼接串——join(',') 可无损地用 [..] 包回数组,一并归一
 */
function parseSegments(v: unknown): NumberSegment[] {
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item !== 'string') return item as NumberSegment
        try {
          return JSON.parse(item) as NumberSegment
        } catch {
          return null
        }
      })
      .filter((s): s is NumberSegment => s != null)
  }
  if (typeof v === 'string' && v !== '') {
    // 读取值是整串 JSON 数组;兜底再试 [..] 包裹(串数组被 String() 逗号拼接的形态)
    for (const candidate of [v, `[${v}]`]) {
      try {
        const arr = JSON.parse(candidate)
        if (Array.isArray(arr)) return arr as NumberSegment[]
      } catch {
        // 换下一种形态
      }
    }
  }
  return []
}

/** 计数器只有 update:值有变的行逐个保存,收集错误文案(带范围键定位)不中途抛出 */
async function persistCounters(current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  for (const row of current) {
    const old = snapshot.find((s) => s.id === row.id)
    if (!old || String(old.value) === String(row.value)) continue
    const data = await gqlFetch<{ updateSysNumberingCounter: { errors: { message: string }[] | null } }>(
      UPDATE_COUNTER,
      { id: row.id, input: { value: row.value } }
    )
    if (data.updateSysNumberingCounter.errors?.length) {
      errors.push(...data.updateSysNumberingCounter.errors.map((e) => `${row.scopeKey}:${e.message}`))
    }
  }
  return errors
}

const GRID_COLUMNS = ['resource', 'name', 'segments', 'perCompany', 'enabled']

const GRID_OVERRIDES = {
  resource: { render: (v) => resourceLabel(String(v ?? '')) },
  segments: {
    label: '规则预览',
    render: (v) => <span className="font-mono text-xs">{segmentsPreview(parseSegments(v))}</span>,
  },
} satisfies Record<string, ColumnOverride>

function NumberingPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [counters, setCounters] = useState<Row[]>([])
  const [countersSnapshot, setCountersSnapshot] = useState<Row[]>([])
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一条规则的计数器回填到当前规则
  const reqIdRef = useRef(0)

  // 可编号资源清单:后端反射 create action 挂了 AutoNumber 的资源,建规则即绑定
  const numberables = useQuery({
    queryKey: ['numberableResources'],
    queryFn: () =>
      gqlFetch<{ numberableResources: NumberableResource[] }>(NUMBERABLE_QUERY).then(
        (d) => d.numberableResources
      ),
    staleTime: 5 * 60_000,
  })
  const gridFor = (prefix: unknown): string | null =>
    numberables.data?.find((n) => n.prefix === prefix)?.grid ?? null

  // 打开抽屉:create 清空;view/edit 按规则 id 拉计数器(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create' || row == null) {
      setCounters([])
      setCountersSnapshot([])
      return
    }
    gqlFetch<{ sysNumberingCounters: { results: Row[] } }>(FETCH_COUNTERS, { ruleId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setCounters(d.sysNumberingCounters.results)
        setCountersSnapshot(d.sysNumberingCounters.results)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('计数器加载失败', { description: (e as Error).message })
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
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="sysNumberingRules"
        label="编号规则"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          // 关闭即作废在途请求并清空快照,防止残留快照被下次提交按差异写误用到别的规则
          reqIdRef.current++
          setDrawer(null)
          setCounters([])
          setCountersSnapshot([])
        }}
        row={drawer?.row}
        // 段组装器/计数器子表默认 480px 局促,加宽一档(移动端仍全宽)
        contentClassName="w-full lg:w-[640px]"
        fields={{
          resource: {
            required: true,
            edit: 'createOnly',
            // 改绑定资源则已选字段段失效,一并清空(仅 create 态可改)
            effects: () => ({ segments: [] }),
            render: (value) => resourceLabel(String(value ?? '')),
            input: ({ value, onChange, isDisabled }) => (
              <Select
                isDisabled={isDisabled}
                isRequired
                placeholder="选择要自动编号的单据…"
                value={value == null ? null : String(value)}
                onChange={(v) => onChange(v)}
              >
                <Label>绑定单据</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {(numberables.data ?? []).map((n) => (
                      <ListBox.Item key={n.prefix} id={n.prefix} textValue={resourceLabel(n.prefix)}>
                        {resourceLabel(n.prefix)}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            ),
          },
          name: { required: true, placeholder: '如 记账凭证编号' },
          segments: {
            required: true,
            render: (value) => (
              <span className="font-mono text-sm">{segmentsPreview(parseSegments(value)) || '—'}</span>
            ),
            input: ({ value, onChange, isDisabled, values }) => (
              <SegmentsEditor
                grid={gridFor(values.resource)}
                value={parseSegments(value)}
                onChange={onChange}
                isDisabled={isDisabled}
              />
            ),
          },
          perCompany: { defaultValue: true, cols: 6 },
          enabled: { defaultValue: true, cols: 6 },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        extraContent={(mode, row) =>
          row == null ? null : (
            <SynieEditableTable
              resource="sysNumberingCounters"
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
          if (segments.length === 0 || !segments.some((s) => s.type === 'seq')) {
            throw new Error('编号段不能为空,且必须包含一个序号段')
          }
          const input = { ...values, segments: segments.map((s) => JSON.stringify(s)) }

          if (mode === 'create') {
            const data = await gqlFetch<{
              createSysNumberingRule: { errors: { message: string }[] | null }
            }>(CREATE_RULE, { input })
            if (data.createSysNumberingRule.errors?.length) {
              throw new Error(data.createSysNumberingRule.errors.map((e) => e.message).join('; '))
            }
            toast.success('编号规则已创建')
          } else {
            const data = await gqlFetch<{
              updateSysNumberingRule: { errors: { message: string }[] | null }
            }>(UPDATE_RULE, { id: drawer!.row!.id, input })
            if (data.updateSysNumberingRule.errors?.length) {
              throw new Error(data.updateSysNumberingRule.errors.map((e) => e.message).join('; '))
            }
            const counterErrors = await persistCounters(counters, countersSnapshot)
            if (counterErrors.length > 0) {
              toast.danger('规则已更新,但部分计数器保存失败', { description: counterErrors.join('; ') })
            } else {
              toast.success('编号规则已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'sysNumberingRules'] })
        }}
      />
    </>
  )
}
