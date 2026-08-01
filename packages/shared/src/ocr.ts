import { decimal } from './decimal.ts'

export type OcrPrefill = Record<string, unknown>

const nonAmountCharacters = /[^0-9.\-]/g
const dateNumbers = /\d+/g
const rangeNumbers = /\d+/g

function nested(input: Record<string, unknown>): Record<string, unknown> {
  return input.data && typeof input.data === 'object' && !Array.isArray(input.data)
    ? input.data as Record<string, unknown>
    : input
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function amount(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? value.replace(nonAmountCharacters, '') : ''
}

function date(value: unknown): string {
  const parts = text(value).match(dateNumbers) ?? []
  let year = ''; let month = ''; let day = ''
  if (parts.length >= 3 && parts[0]!.length === 4) {
    ;[year, month, day] = [parts[0]!, parts[1]!, parts[2]!]
  } else if (parts.length === 1 && parts[0]!.length === 8) {
    year = parts[0]!.slice(0, 4); month = parts[0]!.slice(4, 6); day = parts[0]!.slice(6, 8)
  } else return ''
  const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const parsed = new Date(`${result}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result ? '' : result
}

function putText(target: OcrPrefill, key: string, value: unknown): void {
  const parsed = text(value); if (parsed) target[key] = parsed
}

function putAmount(target: OcrPrefill, key: string, value: unknown): void {
  const parsed = amount(value); if (parsed) target[key] = parsed
}

function putDate(target: OcrPrefill, key: string, value: unknown): void {
  const parsed = date(value); if (parsed) target[key] = parsed
}

function invoiceKind(value: string): string {
  if (!value) return ''
  const special = value.includes('专用')
  if (value.includes('数电') && special) return 'DIGITAL_SPECIAL'
  if (value.includes('数电')) return 'DIGITAL_NORMAL'
  if (value.includes('电子') && special) return 'ELECTRONIC_SPECIAL'
  if (value.includes('电子')) return 'ELECTRONIC_NORMAL'
  return special ? 'SPECIAL' : 'NORMAL'
}

export function mapInvoiceOcr(input: Record<string, unknown>): OcrPrefill {
  const data = nested(input)
  const result: OcrPrefill = {}
  putText(result, 'invoiceCode', data.invoiceCode)
  putText(result, 'invoiceNo', data.invoiceNumber)
  putDate(result, 'invoiceDate', data.invoiceDate)
  const kind = invoiceKind(text(data.invoiceType)); if (kind) result.invoiceKind = kind
  putText(result, 'sellerName', data.sellerName)
  putText(result, 'sellerTaxNo', data.sellerTaxNumber)
  putText(result, 'sellerAddressPhone', data.sellerContactInfo)
  putText(result, 'sellerBankAccount', data.sellerBankAccountInfo)
  putText(result, 'buyerName', data.purchaserName)
  putText(result, 'buyerTaxNo', data.purchaserTaxNumber)
  putText(result, 'buyerAddressPhone', data.purchaserContactInfo)
  putText(result, 'buyerBankAccount', data.purchaserBankAccountInfo)
  putAmount(result, 'netTotal', data.invoiceAmountPreTax)
  putAmount(result, 'taxTotal', data.invoiceTax)
  putAmount(result, 'grossTotal', data.totalAmount)
  putText(result, 'issuer', data.drawer)
  putText(result, 'reviewer', data.reviewer)
  putText(result, 'payee', data.recipient)
  putText(result, 'remarks', data.remarks)
  if (Array.isArray(data.invoiceDetails)) {
    const items: OcrPrefill[] = []
    for (const raw of data.invoiceDetails) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>; const item: OcrPrefill = {}
      putText(item, 'name', row.itemName); putText(item, 'model', row.specification)
      putText(item, 'unit', row.unit); putAmount(item, 'quantity', row.quantity)
      putAmount(item, 'price', row.unitPrice); putAmount(item, 'net_amount', row.amount)
      putText(item, 'tax_rate', row.taxRate); putAmount(item, 'tax_amount', row.tax)
      items.push(item)
    }
    if (items.length) result.items = items
  }
  return result
}

export function parseOcrRange(value: string): { start: number; end: number } | null {
  const parts = value.match(rangeNumbers) ?? []
  if (!parts.length) return null
  const start = Number.parseInt(parts[0]!, 10)
  if (!Number.isFinite(start) || start < 1) return null
  const end = parts.length > 1 ? Number.parseInt(parts[1]!, 10) : start
  return Number.isFinite(end) && end >= start ? { start, end } : null
}

export function mapAcceptanceOcr(input: Record<string, unknown>): OcrPrefill {
  const data = nested(input); const result: OcrPrefill = {}
  putText(result, 'bill_no', data.draftNumber)
  putDate(result, 'issue_date', data.issueDate)
  putDate(result, 'due_date', data.validToDate)
  putDate(result, 'acceptance_date', data.acceptanceDate)
  const assign = text(data.assignability); if (assign) result.transferable = !assign.includes('不')
  putText(result, 'drawer_name', data.issuerName)
  putText(result, 'drawer_account', data.issuerAccountNumber)
  putText(result, 'drawer_bank_name', data.issuerAccountBank)
  putText(result, 'payee_name', data.payeeName)
  putText(result, 'payee_account', data.payeeAccountNumber)
  putText(result, 'payee_bank_name', data.payeeAccountBank)
  putText(result, 'acceptor_name', data.acceptorName)
  putText(result, 'acceptor_account', data.acceptorAccountNumber)
  putText(result, 'acceptor_bank_name', data.acceptorAccountBank)
  putText(result, 'acceptor_bank_no', data.acceptorBankNumber)
  if (Object.keys(result).length) result.bill_kind = 'BANK_ACCEPTANCE'
  const range = parseOcrRange(text(data.subDraftNumber))
  if (range) {
    result.sub_start = range.start; result.sub_end = range.end
    result.amount = decimal(range.end - range.start + 1).div(100).toFixed(2)
  } else {
    const total = amount(data.totalAmount)
    if (total) {
      try {
        const cents = decimal(total).mul(100).toDecimalPlaces(0).toNumber()
        if (cents >= 1) {
          result.sub_start = 1; result.sub_end = cents; result.amount = total
        }
      } catch { /* invalid provider amount is ignored */ }
    }
  }
  return result
}
