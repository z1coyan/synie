import { unboundCommandAdapter, unboundResourceClient, unavailableResourceOperation } from './unbound'

export const salesQuotationClient = unboundResourceClient('salQuotations')
export const salesQuotationItemClient = unboundResourceClient('salQuotationItems')
export const salesQuotationTierClient = unboundResourceClient('salQuotationTiers')
export const purchaseQuotationClient = unboundResourceClient('purQuotations')
export const purchaseQuotationItemClient = unboundResourceClient('purQuotationItems')
export const purchaseQuotationTierClient = unboundResourceClient('purQuotationTiers')

export const salesQuotationCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['salQuotationItems'] },
  void: { target: 'row', affectedResources: ['salQuotationItems'] },
})
export const purchaseQuotationCommandAdapter = unboundCommandAdapter({
  audit: { target: 'row', affectedResources: ['purQuotationItems'] },
  void: { target: 'row', affectedResources: ['purQuotationItems'] },
})
export const auditSalesQuotation = unavailableResourceOperation
export const voidSalesQuotation = unavailableResourceOperation
export const auditPurchaseQuotation = unavailableResourceOperation
export const voidPurchaseQuotation = unavailableResourceOperation
