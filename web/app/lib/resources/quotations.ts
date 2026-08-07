import { apiData, api } from '../api/client'
import { createRowCommandAdapter } from './catalog/commands'
import { restTransport } from './rest-transport'

export async function auditSalesQuotation(id: string) {
  return apiData(
    api.sales.quotations[':id'].audit.$post({
      param: { id }}),
  )
}

export async function voidSalesQuotation(id: string) {
  return apiData(
    api.sales.quotations[':id'].void.$post({
      param: { id }}),
  )
}

export async function auditPurchaseQuotation(id: string) {
  return apiData(
    api.purchase.quotations[':id'].audit.$post({
      param: { id }}),
  )
}

export async function voidPurchaseQuotation(id: string) {
  return apiData(
    api.purchase.quotations[':id'].void.$post({
      param: { id }}),
  )
}

export const salesQuotationCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditSalesQuotation,
    affectedResources: ['salQuotationItems'],
  },
  void: {
    handler: voidSalesQuotation,
    affectedResources: ['salQuotationItems'],
  },
})

export const purchaseQuotationCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditPurchaseQuotation,
    affectedResources: ['purQuotationItems'],
  },
  void: {
    handler: voidPurchaseQuotation,
    affectedResources: ['purQuotationItems'],
  },
})

export const salesQuotationClient = restTransport(
  'salQuotations',
  api.sales.quotations,
)

export const salesQuotationItemClient = restTransport(
  'salQuotationItems',
  api.sales['quotation-items'])

export const salesQuotationTierClient = restTransport(
  'salQuotationTiers',
  api.sales['quotation-tiers'])

export const purchaseQuotationClient = restTransport(
  'purQuotations',
  api.purchase.quotations,
)

export const purchaseQuotationItemClient = restTransport(
  'purQuotationItems',
  api.purchase['quotation-items'])

export const purchaseQuotationTierClient = restTransport(
  'purQuotationTiers',
  api.purchase['quotation-tiers'])
