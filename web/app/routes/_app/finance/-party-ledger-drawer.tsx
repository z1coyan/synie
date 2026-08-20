import { useMemo } from 'react'
import { Button, Spinner } from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { useQuery } from '@tanstack/react-query'
import { formatAmount, formatQty } from '~/lib/amount'
import {
  fetchARAPPartyLedger,
  type ARAPLedgerSide,
  type ARAPPartyLedgerRow,
} from '~/lib/resources/accounting'
import { resourceBindingFor } from '~/lib/resources/registry'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { createLocalRowsTransport } from '~/components/synie-data-grid/query-local'
import type { GridColumnMeta, LocalGridMeta, Row } from '~/components/synie-data-grid/types'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'

const ROLE_COLS: Record<ARAPLedgerSide, { key: string; label: string }[]> = {
  ar: [
    { key: 'unbilledReceivable', label: '未开票应收' },
    { key: 'receivable', label: '应收账款' },
  ],
  ap: [
    { key: 'unbilledPayable', label: '未开票应付' },
    { key: 'payable', label: '应付账款' },
    { key: 'otherPayable', label: '其他应付款' },
  ],
}

function field(
  name: string,
  type: GridColumnMeta['type'],
  label: string,
  extra: Partial<GridColumnMeta> = {},
): GridColumnMeta {
  return {
    name,
    type,
    label,
    sortable: true,
    filterable: true,
    enumOptions: extra.enumOptions ?? null,
    ref: extra.ref ?? null,
  }
}

function ledgerMeta(side: ARAPLedgerSide, typeLabels: string[]): LocalGridMeta {
  const roles = ROLE_COLS[side].map((c) => field(c.key, 'decimal', c.label))
  const enumOptions = typeLabels.map((value) => ({ value, label: value }))
  return {
    columns: [
      field('postingDate', 'date', '日期'),
      field('voucherTypeLabel', 'enum', '类型', { enumOptions }),
      field('voucherNo', 'string', '单号'),
      field('materialLabel', 'string', '物料'),
      field('qty', 'decimal', '数量'),
      field('amount', 'decimal', '金额'),
      ...roles,
      field('remarks', 'string', '备注'),
    ],
  }
}

function flattenRow(row: ARAPPartyLedgerRow): Row {
  return {
    id: row.id,
    postingDate: row.postingDate,
    voucherTypeLabel: row.voucherTypeLabel,
    voucherNo: row.voucherNo,
    voucherId: row.voucherId,
    voucherResource: row.voucherResource,
    materialLabel: row.materialLabel ?? '',
    qty: row.qty,
    unitLabel: row.unitLabel,
    amount: row.amount,
    remarks: row.remarks ?? '',
    ...row.balances,
  }
}

const amountOverride = (align: 'end' = 'end'): ColumnOverride => ({
  align,
  render: (value) => (value == null || value === '' ? '—' : formatAmount(value)),
})

export function PartyLedgerDrawer(props: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  asOf: string
  side: ARAPLedgerSide
  partyType: string | null
  partyId: string | null
  partyLabel: string
  canExport?: boolean
  canPrint?: boolean
  onExport?: () => void
  onPrint?: () => void
}) {
  const openPreview = useFkPreview()
  const partyNil = props.partyId == null
  const query = useQuery({
    queryKey: [
      'arApPartyLedger',
      props.companyId,
      props.asOf,
      props.side,
      props.partyType,
      props.partyId,
    ],
    enabled: props.isOpen && props.companyId !== '' && props.asOf !== '',
    queryFn: () =>
      fetchARAPPartyLedger({
        companyId: props.companyId,
        asOf: props.asOf,
        side: props.side,
        partyType: props.partyType,
        partyId: props.partyId,
        partyNil,
      }),
  })
  const rows = useMemo(() => (query.data?.rows ?? []).map(flattenRow), [query.data])
  const meta = useMemo(() => {
    const labels = [
      ...new Set(rows.map((row) => String(row.voucherTypeLabel ?? '')).filter((label) => label !== '')),
    ].sort((a, b) => a.localeCompare(b, 'zh'))
    return ledgerMeta(props.side, labels)
  }, [props.side, rows])
  const client = useMemo(
    () => createLocalRowsTransport(`memory:accArApPartyLedger:${props.side}`, rows, meta.columns),
    [rows, meta, props.side],
  )
  const title = `${props.partyLabel} · 往来明细`

  const openSource = (row: Row) => {
    const resource = row.voucherResource
    const id = row.voucherId
    if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') return
    try {
      resourceBindingFor(resource)
    } catch {
      return
    }
    openPreview(resource, id)
  }

  const overrides: Record<string, ColumnOverride> = {
    voucherNo: {
      render: (value, row) => {
        const no = value == null || value === '' ? '' : String(value)
        if (!no) return '—'
        if (!row.voucherResource) return no
        return (
          <Button variant="ghost" className="h-auto px-0 text-accent" onPress={() => openSource(row)}>
            {no}
          </Button>
        )
      },
    },
    qty: {
      align: 'end',
      render: (value, row) => {
        if (value == null || value === '') return '—'
        const unit = typeof row.unitLabel === 'string' && row.unitLabel !== '' ? ` ${row.unitLabel}` : ''
        return `${formatQty(value)}${unit}`
      },
    },
    amount: amountOverride(),
    unbilledReceivable: amountOverride(),
    receivable: amountOverride(),
    unbilledPayable: amountOverride(),
    payable: amountOverride(),
    otherPayable: amountOverride(),
  }

  return (
    <Sheet isOpen={props.isOpen} onOpenChange={props.onOpenChange} placement="right" isHandleOnly>
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[960px]">
          <Sheet.Dialog className="h-full" aria-label={title}>
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {query.isPending ? (
                <div className="flex h-64 items-center justify-center">
                  <Spinner size="lg" />
                </div>
              ) : query.isError ? (
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>往来明细加载失败</EmptyState.Title>
                    <EmptyState.Description>{(query.error as Error).message}</EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <SynieDataGrid
                  key={`${props.side}:${props.partyId ?? 'nil'}:${query.dataUpdatedAt}`}
                  resource="accArApPartyLedger"
                  meta={meta}
                  client={client}
                  urlState={false}
                  defaultSort={{ column: 'postingDate', direction: 'descending' }}
                  overrides={overrides}
                />
              )}
            </Sheet.Body>
            <Sheet.Footer>
              {props.canExport && (
                <Button variant="secondary" onPress={props.onExport}>
                  导出
                </Button>
              )}
              {props.canPrint && (
                <Button variant="secondary" onPress={props.onPrint}>
                  打印
                </Button>
              )}
              <Sheet.Close>
                <Button variant="secondary">关闭</Button>
              </Sheet.Close>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}
