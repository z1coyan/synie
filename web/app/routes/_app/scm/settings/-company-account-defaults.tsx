import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Spinner, toast } from '@heroui/react'
import type { FilterState } from '~/components/synie-data-grid/types'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { fetchSalesCompanyAccountDefaults } from '~/lib/resources/fulfillment'
import { companyAccountDefaultClient } from '~/lib/resources/reconciliations'

type CompanyDefaultRow = {
  id: string
  deliveryDebitAccountId: string | null
  deliveryCreditAccountId: string | null
  receiptDebitAccountId: string | null
  receiptCreditAccountId: string | null
}

function accountFilter(companyId: string | null, roleEnum?: string): FilterState | undefined {
  if (!companyId) return undefined
  return {
    companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
    isGroup: { kind: 'bool', eq: false },
    active: { kind: 'bool', eq: true },
    ...(roleEnum ? { role: { kind: 'enum' as const, values: [roleEnum] } } : {}),
  }
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
    queryFn: () =>
      fetchSalesCompanyAccountDefaults(String(companyId)) as Promise<CompanyDefaultRow | null>,
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
        await companyAccountDefaultClient.update?.(rowId, input)
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
        await companyAccountDefaultClient.create?.(input)
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
              filterState={accountFilter(companyId, debitRole)}
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
              filterState={accountFilter(companyId, creditRole)}
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
  return fetchSalesCompanyAccountDefaults(companyId)
}
