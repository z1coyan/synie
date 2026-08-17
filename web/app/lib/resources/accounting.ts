import { apiData, api } from '../api/client'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import { restTransport } from './rest-transport'

export interface ARAPRoleAccount {
  id: string
  code: string
  name: string
  accountId?: string
  accountCode?: string
  accountName?: string
}
export interface ARAPBalances {
  [key: string]: string
}
export interface ARAPReportRow {
  partyType: string | null
  partyId: string | null
  partyLabel: string
  balances: ARAPBalances
  netReceivable: string
  netPayable: string
}
export interface ARAPReport {
  asOf: string
  roleAccounts: Record<string, ARAPRoleAccount[]>
  rows: ARAPReportRow[]
}

export const glEntryClient = restTransport(
  'accGlEntries',
  api.accounting['gl-entries'],
  { capabilities: { create: false, update: false, delete: false } },
)

async function auditGlJournal(id: string, postingDate?: string) {
  return apiData(
    api.accounting['gl-journals'][':id'].audit.$post({
      param: { id },
      json: postingDate ? { postingDate } : {} }),
  )
}

export async function cancelGlJournal(id: string) {
  return apiData(
    api.accounting['gl-journals'][':id'].cancel.$post({
      param: { id }}),
  )
}

export const glJournalCommandAdapter = createCommandAdapter({
  audit: defineCommand(
    'row',
    async (input: unknown) => {
      const id = decodeRowTarget(input)
      const postingDate = (input as Record<string, unknown>).postingDate
      if (
        postingDate !== undefined &&
        (typeof postingDate !== 'string' || postingDate.trim() === '')
      ) {
        throw new Error('audit postingDate 须为非空字符串')
      }
      return auditGlJournal(id, postingDate)
    },
    { affectedResources: ['accGlEntries'] },
  ),
  cancel: defineCommand(
    'row',
    async (input: unknown) => cancelGlJournal(decodeRowTarget(input)),
    { affectedResources: ['accGlEntries'] },
  ),
})

export const glJournalClient = restTransport(
  'accGlJournals',
  api.accounting['gl-journals'],
)

export const glJournalLineClient = restTransport(
  'accGlJournalLines',
  api.accounting['gl-journal-lines'])

export function fetchARAPReport(companyId: string, asOf: string): Promise<ARAPReport> {
  return apiData(
    api.accounting['ar-ap-report'].$get({
      query: { companyId, asOf }}),
  )
}

export type ARAPLedgerSide = 'ar' | 'ap'

export interface ARAPPartyLedgerRow {
  id: string
  postingDate: string
  seq: number
  voucherType: string
  voucherTypeLabel: string
  voucherId: string
  voucherNo: string
  voucherResource: string | null
  isReversal: boolean
  itemId: string | null
  materialLabel: string | null
  qty: string | null
  unitLabel: string | null
  amount: string
  balances: Record<string, string>
  remarks: string | null
}

export interface ARAPPartyLedger {
  asOf: string
  side: ARAPLedgerSide
  partyType: string | null
  partyId: string | null
  rows: ARAPPartyLedgerRow[]
}

export function fetchARAPPartyLedger(query: {
  companyId: string
  asOf: string
  side: ARAPLedgerSide
  partyType?: string | null
  partyId?: string | null
  partyNil?: boolean
}): Promise<ARAPPartyLedger> {
  return apiData(
    api.accounting['ar-ap-party-ledger'].$get({
      query: {
        companyId: query.companyId,
        asOf: query.asOf,
        side: query.side,
        partyType: query.partyNil ? undefined : (query.partyType ?? undefined),
        partyId: query.partyNil ? undefined : (query.partyId ?? undefined),
        partyNil: query.partyNil ? 'true' : undefined,
      },
    }),
  )
}
