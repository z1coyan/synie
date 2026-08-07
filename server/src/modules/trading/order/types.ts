/**
 * 销售/采购订单 DTO / 草稿输入类型。
 */
import type {
  OutsourcedDraftLineInput,
  OutsourcedSavedIssueLine,
  OutsourcedSavedLine,
} from './outsourced-config.ts'

export interface Order {
  id: string
  orderNo: string
  orderDate: string
  orderType: string
  isOutsourced: boolean
  partyType: string
  partyId: string
  exchangeRate: string
  terms: string | null
  remarks: string | null
  status: string
  auditedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  currencyId: string
  createdById: string | null
  auditedById: string | null
  grossTotal: string
  baseGrossTotal: string
  company: { id: string; name: string }
  currency: { id: string; code: string; name: string }
  createdBy: { id: string; name: string } | null
  auditedBy: { id: string; name: string } | null
  [key: string]: unknown
}

export interface OrderItem {
  id: string
  idx: number
  qty: string
  baseQty: string
  shippedQty?: string
  receivedQty?: string
  price: string
  amount: string
  basePrice: string
  baseAmount: string
  taxRate: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  customerPartNo: string | null
  unitName: string
  remarks: string | null
  demandDate?: string | null
  insertedAt: string
  updatedAt: string
  orderId: string
  companyId: string
  materialId: string
  unitId: string
  quotationItemId: string | null
  pricingMode: string | null
  bomId?: string | null
  bomCode?: string | null
  bomPlanName?: string | null
  demandLineId?: string | null
  demandNo?: string | null
  orderNo: string
  orderDate: string
  orderStatus: string
  orderIsOutsourced?: boolean
  partyType: string
  partyId: string
  currencyCode: string
  remainingBaseQty: string
  order: { id: string; orderNo: string }
  company: { id: string; name: string }
  material: { id: string; code: string; name: string }
  unit: { id: string; name: string }
  [key: string]: unknown
}

export interface OrderHeadCreateInput {
  companyId: string
  orderNo?: string | null
  orderDate?: string | null
  orderType?: string
  isOutsourced?: boolean
  partyType: string
  partyId: string
  currencyId?: string | null
  exchangeRate?: string | null
  terms?: string | null
  remarks?: string | null
}

export interface OrderHeadUpdateInput {
  orderNo?: string
  orderDate?: string
  orderType?: string
  isOutsourced?: boolean
  partyType?: string
  partyId?: string
  currencyId?: string
  exchangeRate?: string
  terms?: string | null
  termsPresent?: boolean
  remarks?: string | null
  remarksPresent?: boolean
}

export interface OrderItemCreateInput {
  orderId: string
  idx: number
  qty: string
  materialId: string
  unitId: string
  price?: string | null
  taxRate?: string | null
  remarks?: string | null
  quotationItemId?: string | null
  bomId?: string | null
  demandLineId?: string | null
  demandDate?: string | null
}

export interface OrderItemUpdateInput {
  idx?: number
  qty?: string
  materialId?: string
  unitId?: string
  price?: string
  taxRate?: string
  remarks?: string | null
  remarksPresent?: boolean
  quotationItemId?: string | null
  quotationItemIdPresent?: boolean
  bomId?: string | null
  bomIdPresent?: boolean
  demandLineId?: string | null
  demandLineIdPresent?: boolean
  demandDate?: string | null
  demandDatePresent?: boolean
}

export interface OrderDraftItemInput extends Omit<OrderItemCreateInput, 'orderId'> {
  id?: string
  issueLines: OutsourcedDraftLineInput[]
  byproductLines: OutsourcedDraftLineInput[]
}

export interface OrderDraftInput extends OrderHeadCreateInput {
  items: OrderDraftItemInput[]
}

export type OrderSavedDraft = Order & {
  items: Array<
    OrderItem & {
      issueLines: OutsourcedSavedIssueLine[]
      byproductLines: OutsourcedSavedLine[]
    }
  >
}
