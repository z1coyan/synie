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
