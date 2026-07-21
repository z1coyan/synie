import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'

const FETCH_DEFAULTS = `
  query ($companyId: ID!) {
    salCompanyAccountDefaults(
      filter: {companyId: {eq: $companyId}}
      limit: 1
      offset: 0
    ) {
      results {
        id
        deliveryDebitAccountId
        deliveryCreditAccountId
        receiptDebitAccountId
        receiptCreditAccountId
      }
    }
  }
`
const CREATE_DEFAULTS = `
  mutation ($input: CreateSalCompanyAccountDefaultInput!) {
    createSalCompanyAccountDefault(input: $input) {
      result { id }
      errors { message }
    }
  }
`
const UPDATE_DEFAULTS = `
  mutation ($id: ID!, $input: UpdateSalCompanyAccountDefaultInput!) {
    updateSalCompanyAccountDefault(id: $id, input: $input) {
      result { id }
      errors { message }
    }
  }
`

type CompanyDefaultRow = {
  id: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
}

function accountFilter(companyId: string | null, roleEnum?: string): string | undefined {
  if (!companyId) return undefined
  const base = `companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}`
  if (roleEnum) return `{${base}, role: {eq: ${roleEnum}}}`
  return `{${base}}`
}

export type CompanyAccountSide = 'delivery' | 'receipt'

/**
 * 供应链设置内「按公司默认过账科目」卡片。
 * side=delivery → 销售 Tab 编发货两槽;side=receipt → 采购 Tab 编入库两槽。
 * 本侧保存只 upsert 本侧两槽,不覆盖对侧。
 */
export function CompanyAccountDefaultsCard({ side }: { side: CompanyAccountSide }) {
  const queryClient = useQueryClient()
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [debitId, setDebitId] = useState<string | null>(null)
  const [creditId, setCreditId] = useState<string | null>(null)
  const [rowId, setRowId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const defaultsQuery = useQuery({
    queryKey: ['salCompanyAccountDefaults', companyId],
    enabled: companyId != null && companyId !== '',
    queryFn: async () => {
      const data = await gqlFetch<{
        salCompanyAccountDefaults: { results: CompanyDefaultRow[] }
      }>(FETCH_DEFAULTS, { companyId })
      return data.salCompanyAccountDefaults.results[0] ?? null
    },
  })

  useEffect(() => {
    if (!companyId) {
      setRowId(null)
      setDebitId(null)
      setCreditId(null)
      return
    }
    if (defaultsQuery.isFetching) return
    const row = defaultsQuery.data
    setRowId(row?.id ?? null)
    if (side === 'delivery') {
      setDebitId(row?.deliveryDebitAccountId ?? null)
      setCreditId(row?.deliveryCreditAccountId ?? null)
    } else {
      setDebitId(row?.receiptDebitAccountId ?? null)
      setCreditId(row?.receiptCreditAccountId ?? null)
    }
  }, [companyId, defaultsQuery.data, defaultsQuery.isFetching, side])

  const save = async () => {
    if (!companyId) {
      toast.danger('请先选择公司')
      return
    }
    setSaving(true)
    try {
      if (rowId) {
        // 更新只写本侧两槽,对侧不动(input 不传对侧字段)
        const input =
          side === 'delivery'
            ? {
                deliveryDebitAccountId: debitId,
                deliveryCreditAccountId: creditId,
              }
            : {
                receiptDebitAccountId: debitId,
                receiptCreditAccountId: creditId,
              }
        const data = await gqlFetch<{
          updateSalCompanyAccountDefault: { errors: { message: string }[] | null }
        }>(UPDATE_DEFAULTS, { id: rowId, input })
        if (data.updateSalCompanyAccountDefault.errors?.length) {
          throw new Error(data.updateSalCompanyAccountDefault.errors.map((e) => e.message).join('; '))
        }
      } else {
        const input =
          side === 'delivery'
            ? {
                companyId,
                deliveryDebitAccountId: debitId,
                deliveryCreditAccountId: creditId,
              }
            : {
                companyId,
                receiptDebitAccountId: debitId,
                receiptCreditAccountId: creditId,
              }
        const data = await gqlFetch<{
          createSalCompanyAccountDefault: { errors: { message: string }[] | null }
        }>(CREATE_DEFAULTS, { input })
        if (data.createSalCompanyAccountDefault.errors?.length) {
          throw new Error(data.createSalCompanyAccountDefault.errors.map((e) => e.message).join('; '))
        }
      }
      toast.success(side === 'delivery' ? '发货默认科目已保存' : '入库默认科目已保存')
      queryClient.invalidateQueries({ queryKey: ['salCompanyAccountDefaults'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const title = side === 'delivery' ? '销售发货默认科目' : '采购入库默认科目'
  const description =
    side === 'delivery'
      ? '按公司配置发货单借贷默认科目;新建或换公司时整组覆盖代入。可空,无默认不挡建单。'
      : '按公司配置入库单借贷默认科目;新建或换公司时整组覆盖代入。可空,无默认不挡建单。'
  const debitLabel = side === 'delivery' ? '默认借方科目(未开票应收)' : '默认借方科目'
  const creditLabel = side === 'delivery' ? '默认贷方科目' : '默认贷方科目(未开票应付)'
  const debitRole = side === 'delivery' ? 'UNBILLED_RECEIVABLE' : undefined
  const creditRole = side === 'receipt' ? 'UNBILLED_PAYABLE' : undefined

  return (
    <Card className="mt-4 max-w-2xl">
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        <Card.Description>{description}</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <RemoteSelect
          resource="basCompanies"
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          onChange={(id) => setCompanyId(id)}
          searchFields={['name', 'code']}
          itemSubtitleFields={['code']}
        />
        {companyId && defaultsQuery.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner size="sm" />
          </div>
        ) : companyId ? (
          <div className="grid grid-cols-1 gap-4">
            <RemoteSelect
              resource="basAccounts"
              label={debitLabel}
              placeholder="可空,选择默认借方…"
              value={debitId}
              onChange={(id) => setDebitId(id)}
              filter={accountFilter(companyId, debitRole)}
              labelField="name"
              searchFields={['name', 'code']}
              itemSubtitleFields={['code']}
            />
            <RemoteSelect
              resource="basAccounts"
              label={creditLabel}
              placeholder="可空,选择默认贷方…"
              value={creditId}
              onChange={(id) => setCreditId(id)}
              filter={accountFilter(companyId, creditRole)}
              labelField="name"
              searchFields={['name', 'code']}
              itemSubtitleFields={['code']}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">先选择公司后配置默认科目</p>
        )}
        {companyId ? (
          <div>
            <Button isPending={saving} onPress={save}>
              保存默认科目
            </Button>
          </div>
        ) : null}
      </Card.Content>
    </Card>
  )
}

/** 拉取某公司默认过账科目(抽屉代入用;无权限/失败返回空)。 */
export async function fetchCompanyAccountDefaults(
  companyId: string,
): Promise<CompanyDefaultRow | null> {
  try {
    const data = await gqlFetch<{
      salCompanyAccountDefaults: { results: CompanyDefaultRow[] }
    }>(FETCH_DEFAULTS, { companyId })
    return data.salCompanyAccountDefaults.results[0] ?? null
  } catch {
    return null
  }
}
