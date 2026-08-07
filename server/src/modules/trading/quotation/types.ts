import type { Decimal } from '@synie/shared'

export interface Quotation {
  id: string
  quotationNo: string
  quotationDate: string
  validUntil: string
  partyType: string
  partyId: string
  terms: string | null
  remarks: string | null
  status: string
  auditedAt: Date | null
  insertedAt: Date
  updatedAt: Date
  companyId: string
  currencyId: string
  createdById: string | null
  auditedById: string | null
  company: { id: string; name: string }
  currency: { id: string; code: string; name: string }
  createdBy: { id: string; name: string } | null
  auditedBy: { id: string; name: string } | null
  [key: string]: unknown
}

export interface QuotationItem {
  id: string
  idx: number
  pricingMode: string
  price: string | null
  taxRate: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  insertedAt: Date
  updatedAt: Date
  quotationId: string
  companyId: string
  materialId: string
  unitId: string
  tierCount: number
  quotationDate: string
  validUntil: string
  quotationStatus: string
  partyType: string
  partyId: string
  currencyCode: string
  quotation: { id: string; quotationNo: string }
  company: { id: string; name: string }
  material: { id: string; code: string; name: string }
  unit: { id: string; name: string }
  [key: string]: unknown
}

export interface QuotationTier {
  id: string
  minQty: string
  price: string
  insertedAt: Date
  updatedAt: Date
  itemId: string
  companyId: string
  company: { id: string; name: string }
  [key: string]: unknown
}

export interface QuotationHeadCreateInput {
  companyId: string
  quotationNo?: string | null
  quotationDate?: string | null
  validUntil: string
  partyType: string
  partyId: string
  currencyId?: string | null
  terms?: string | null
  remarks?: string | null
}

export interface QuotationHeadUpdateInput {
  quotationNo?: string
  quotationDate?: string
  validUntil?: string
  partyType?: string
  partyId?: string
  currencyId?: string
  terms?: string | null
  termsPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface QuotationItemCreateInput {
  quotationId: string
  idx: number
  materialId: string
  unitId: string
  pricingMode?: string
  price?: string | null
  taxRate?: string | null
  remarks?: string | null
}

export interface QuotationItemUpdateInput {
  idx?: number
  materialId?: string
  unitId?: string
  pricingMode?: string
  price?: string | null
  pricePresent?: boolean
  taxRate?: string
  remarks?: string | null
  remarksPresent?: boolean
}

export interface QuotationDraftTierInput {
  id?: string
  minQty: string
  price: string
}

export interface QuotationDraftItemInput extends Omit<QuotationItemCreateInput, 'quotationId'> {
  id?: string
  tiers: QuotationDraftTierInput[]
}

export interface QuotationDraftInput extends QuotationHeadCreateInput {
  items: QuotationDraftItemInput[]
}

export type QuotationSavedDraft = Quotation & {
  items: Array<QuotationItem & { tiers: QuotationTier[] }>
}

export interface ResolveOrderInput {
  quotationItemId: string
  orderDate: string
  companyId: string
  partyType: string
  partyId: string
  currencyId: string
  qty: Decimal | string
}

export interface ResolveOrderResult {
  materialId: string
  unitId: string
  price: Decimal
  taxRate: Decimal
}
