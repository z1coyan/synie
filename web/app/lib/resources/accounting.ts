import { unboundCommandAdapter, unboundResourceClient, unavailableResourceOperation } from './unbound'

export interface ARAPRoleAccount { id: string; code: string; name: string }
export interface ARAPBalances { [key: string]: string }
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

export interface AccountingSemanticOperations {
  arAp(companyId: string, asOf: string): Promise<ARAPReport>
}

let semanticOperations: AccountingSemanticOperations | null = null
export function activateAccountingSemanticOperations(next: AccountingSemanticOperations): void {
  semanticOperations = next
}

export const glEntryClient = unboundResourceClient('accGlEntries')
export const glJournalClient = unboundResourceClient('accGlJournals')
export const glJournalLineClient = unboundResourceClient('accGlJournalLines')
export const glJournalCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['accGlEntries'] },
  cancel: { target: 'row', affectedResources: ['accGlEntries'] },
})
export const cancelGlJournal = unavailableResourceOperation

export function fetchARAPReport(companyId: string, asOf: string): Promise<ARAPReport> {
  if (!semanticOperations) throw new Error('应收应付报表尚未由 Convex 应用壳装配')
  return semanticOperations.arAp(companyId, asOf)
}
