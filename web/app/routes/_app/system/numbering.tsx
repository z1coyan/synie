import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/numbering')({
  component: NumberingPage,
})

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

const GRID_COLUMNS = ['code', 'name', 'format', 'seqPadding', 'resetPeriod', 'perCompany', 'enabled']

function NumberingPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [counters, setCounters] = useState<Row[]>([])
  const [countersSnapshot, setCountersSnapshot] = useState<Row[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  // 打开抽屉:create 清空;view/edit 按规则 id 拉计数器(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    setDrawer({ mode, row })
    if (mode === 'create' || row == null) {
      setCounters([])
      setCountersSnapshot([])
      return
    }
    gqlFetch<{ sysNumberingCounters: { results: Row[] } }>(FETCH_COUNTERS, { ruleId: row.id })
      .then((d) => {
        setCounters(d.sysNumberingCounters.results)
        setCountersSnapshot(d.sysNumberingCounters.results)
      })
      .catch((e) => {
        toast.danger('计数器加载失败', { description: (e as Error).message })
        setCounters([])
        setCountersSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">编号规则</h1>
      <p className="mt-2 text-sm text-ink-500">
        单据自动编号:格式模板支持 {'{company}'}(公司编码)、{'{YYYY}'} {'{YY}'} {'{MM}'} {'{DD}'}
        (取号日期)与 {'{seq}'}(序号)占位;规则标识与业务单据约定对应(如会计凭证为
        acc.gl_journal),计数器由取号自动创建,可在此调整当前序号。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysNumberingRules"
          columns={GRID_COLUMNS}
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
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        // 计数器子表默认 480px 局促,加宽一档(移动端仍全宽)
        contentClassName="w-full lg:w-[560px]"
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '如 acc.gl_journal' },
          name: { required: true, placeholder: '如 记账凭证' },
          format: { required: true, placeholder: '如 记{company}-{YYYY}{MM}-{seq}' },
          seqPadding: { required: true, defaultValue: 4, cols: 6 },
          resetPeriod: { required: true, defaultValue: 'MONTHLY', cols: 6 },
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
          if (mode === 'create') {
            const data = await gqlFetch<{
              createSysNumberingRule: { errors: { message: string }[] | null }
            }>(CREATE_RULE, { input: values })
            if (data.createSysNumberingRule.errors?.length) {
              throw new Error(data.createSysNumberingRule.errors.map((e) => e.message).join('; '))
            }
            toast.success('编号规则已创建')
          } else {
            const data = await gqlFetch<{
              updateSysNumberingRule: { errors: { message: string }[] | null }
            }>(UPDATE_RULE, { id: drawer!.row!.id, input: values })
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
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
