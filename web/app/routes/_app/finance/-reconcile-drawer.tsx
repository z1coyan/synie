import { useEffect, useState } from 'react'
import {
  Alert,
  AlertDialog,
  Button,
  Input,
  Label,
  Modal,
  NumberField,
  TextField,
  toast,
} from '@heroui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatAmount } from '~/lib/amount'
import { bankAccountClient } from '~/lib/resources/finance-operations'
import {
  bankReconciliationClient,
  fetchBankReconciliationRemaining,
  quickCreateBankReconciliation,
} from '~/lib/resources/finance-operations'
import { resourceBindingFor } from '~/lib/resources/registry'
import { executeCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

interface Props {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

export function FinanceReconcileDrawer({
  txn,
  onOpenChange,
  onChanged,
}: Props) {
  const queryClient = useQueryClient()
  return (
    <SynieRecordDrawer
      key={txn?.id ?? ''}
      resource="accBankTransactions"
      label="流水对账"
      mode="view"
      isOpen={txn !== null}
      onOpenChange={onOpenChange}
      rowId={txn?.id}
      contentClassName="w-full lg:w-[880px]"
      exclude={['balance', 'insertedAt', 'updatedAt']}
      extraContent={(_mode, row) =>
        row ? (
          <FinanceReconcileSection
            txn={row}
            onChanged={() => {
              void resourceBindingFor('accBankTransactions').cache.invalidateRow(
                queryClient,
                row.id,
              )
              void resourceBindingFor('accBankReconciliations').cache.invalidateGrid(
                queryClient,
              )
              onChanged()
            }}
          />
        ) : null
      }
    />
  )
}

function FinanceReconcileSection({
  txn,
  onChanged,
}: {
  txn: Row
  onChanged: () => void
}) {
  const [unlink, setUnlink] = useState<Row | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const ledger = useQuery({
    queryKey: ['financeBankAccountLedger', txn.bankAccountId],
    queryFn: async () => {
      const account = await bankAccountClient.get(String(txn.bankAccountId))
      return (account?.accountId as string | null) ?? null
    },
  })
  const journalMeta = useGridMeta('accGlJournals', true)
  const canQuick = ['create', 'audit'].every((capability) =>
    (journalMeta.data?.capabilities ?? []).includes(capability),
  )

  return (
    <div className="flex flex-col gap-4">
      {ledger.data === null && !ledger.isPending && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>该银行账户未绑定会计科目</Alert.Title>
            <Alert.Description>
              请先在「银行账户」中绑定科目,再进行对账。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">
          未对账 {formatAmount(txn.unreconciledAmount)}
        </span>
        {typeof ledger.data === 'string' && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onPress={() => setLinkOpen(true)}>
              关联已有凭证
            </Button>
            {canQuick && (
              <Button size="sm" onPress={() => setQuickOpen(true)}>
                快速新增凭证
              </Button>
            )}
          </div>
        )}
      </div>
      <SynieDataGrid
        resource="accBankReconciliations"
        columns={['journalId', 'amount', 'insertedAt']}
        fixedFilter={{
          bankTransactionId: {
            kind: 'fk',
            values: [txn.id],
            labels: [txn.id],
          },
        }}
        hideSearch
        rowActions={[
          {
            key: 'unlink',
            label: '解除',
            isDanger: true,
            onAction: setUnlink,
          },
        ]}
      />
      <LinkJournalModal
        isOpen={linkOpen}
        onOpenChange={setLinkOpen}
        txn={txn}
        onChanged={onChanged}
      />
      {canQuick && (
        <QuickCreateModal
          isOpen={quickOpen}
          onOpenChange={setQuickOpen}
          txn={txn}
          onChanged={onChanged}
        />
      )}
      <AlertDialog.Backdrop
        isOpen={unlink !== null}
        onOpenChange={(open) => !open && setUnlink(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog aria-label="确认解除对账">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>确认解除对账?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              只解除流水与凭证的关联,不影响凭证本身。
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button
                variant="danger"
                onPress={async () => {
                  if (!unlink) return
                  try {
                    await bankReconciliationClient.delete(unlink.id)
                    setUnlink(null)
                    onChanged()
                    toast.success('已解除对账')
                  } catch (error) {
                    toast.danger('解除失败', {
                      description: (error as Error).message,
                    })
                  }
                }}
              >
                解除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}

function LinkJournalModal({
  isOpen,
  onOpenChange,
  txn,
  onChanged,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  txn: Row
  onChanged: () => void
}) {
  const [picked, setPicked] = useState<Row[]>([])
  const [amount, setAmount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const queryClient = useQueryClient()
  const journal = picked[0]

  const close = () => {
    setPicked([])
    setAmount(null)
    onOpenChange(false)
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="max-w-4xl">
          <Modal.Header>
            <Modal.Heading>关联已有凭证</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <SynieDataGrid
              resource="accGlJournals"
              columns={[
                'voucherNo',
                'date',
                'postingDate',
                'remarks',
                'debitTotal',
                'creditTotal',
              ]}
              fixedFilter={{
                companyId: {
                  kind: 'fk',
                  values: [String(txn.companyId)],
                  labels: [String(txn.companyId)],
                },
                status: { kind: 'enum', values: ['AUDITED'] },
              }}
              pick="single"
              pickedRows={picked}
              onPickChange={(rows) => {
                setPicked(rows)
                const id = rows[0]?.id
                if (!id) {
                  setAmount(null)
                  return
                }
                void fetchBankReconciliationRemaining(txn.id, id)
                  .then((value) => setAmount(Number(value)))
                  .catch((error) =>
                    toast.danger('剩余额度查询失败', {
                      description: (error as Error).message,
                    }),
                  )
              }}
            />
          </Modal.Body>
          <Modal.Footer>
            <NumberField
              className="w-48"
              value={amount ?? NaN}
              onChange={(value) =>
                setAmount(Number.isFinite(value) ? value : null)
              }
            >
              <Label>对账金额</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
            <Button variant="secondary" onPress={close}>
              取消
            </Button>
            <Button
              isDisabled={!journal || amount == null || amount <= 0}
              isPending={submitting}
              onPress={async () => {
                if (!journal || amount == null) return
                setSubmitting(true)
                try {
                  // 语义 command reconcile：row target + transport 仅在 CommandAdapter
                  await executeCommandWithInvalidation(
                    resourceBindingFor('accBankTransactions'),
                    'reconcile',
                    {
                      id: String(txn.id),
                      journalId: String(journal.id),
                      amount: String(amount),
                    },
                    queryClient,
                  )
                  close()
                  onChanged()
                  toast.success('已关联凭证')
                } catch (error) {
                  toast.danger('关联失败', {
                    description: (error as Error).message,
                  })
                } finally {
                  setSubmitting(false)
                }
              }}
            >
              关联
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function QuickCreateModal({
  isOpen,
  onOpenChange,
  txn,
  onChanged,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  txn: Row
  onChanged: () => void
}) {
  const [accountId, setAccountId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [summary, setSummary] = useState(String(txn.summary ?? ''))
  const [postingDate, setPostingDate] = useState(
    String(txn.occurredAt).slice(0, 10),
  )
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const value = Number(txn.unreconciledAmount)
    setAmount(Number.isFinite(value) && value > 0 ? value : null)
  }, [txn.unreconciledAmount])

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="max-w-lg">
          <Modal.Header>
            <Modal.Heading>快速新增凭证并关联</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <RemoteSelect
                resource="basAccounts"
                label={txn.income != null ? '贷方科目' : '借方科目'}
                labelField="name"
                searchFields={['code', 'name']}
                value={accountId}
                onChange={setAccountId}
                filterState={{
                  companyId: { kind: 'fk', values: [String(txn.companyId)], labels: [] },
                  isGroup: { kind: 'bool', eq: false },
                  active: { kind: 'bool', eq: true },
                }}
              />
              <NumberField
                fullWidth
                value={amount ?? NaN}
                onChange={(value) =>
                  setAmount(Number.isFinite(value) ? value : null)
                }
              >
                <Label>金额</Label>
                <NumberField.Group className="grid-cols-[1fr]">
                  <NumberField.Input />
                </NumberField.Group>
              </NumberField>
              <TextField fullWidth value={summary} onChange={setSummary}>
                <Label>摘要</Label>
                <Input />
              </TextField>
              <TextField
                fullWidth
                value={postingDate}
                onChange={setPostingDate}
              >
                <Label>凭证/过账日期</Label>
                <Input type="date" />
              </TextField>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              isDisabled={
                !accountId || amount == null || amount <= 0 || !postingDate
              }
              isPending={submitting}
              onPress={async () => {
                if (!accountId || amount == null || !postingDate) return
                setSubmitting(true)
                try {
                  await quickCreateBankReconciliation({
                    bankTransactionId: txn.id,
                    counterAccountId: accountId,
                    amount: String(amount),
                    summary: summary || null,
                    postingDate,
                  })
                  setAccountId(null)
                  onOpenChange(false)
                  onChanged()
                  toast.success('凭证已创建并完成对账')
                } catch (error) {
                  toast.danger('快速对账失败', {
                    description: (error as Error).message,
                  })
                } finally {
                  setSubmitting(false)
                }
              }}
            >
              保存并对账
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
