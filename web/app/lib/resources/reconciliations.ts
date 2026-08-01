import { unboundCommandAdapter, unboundResourceClient } from './unbound'

export const salesReconciliationClient = unboundResourceClient('salReconciliations')
export const salesReconciliationItemClient = unboundResourceClient('salReconciliationItems')
export const purchaseReconciliationClient = unboundResourceClient('purReconciliations')
export const purchaseReconciliationItemClient = unboundResourceClient('purReconciliationItems')
export const companyAccountDefaultClient = unboundResourceClient('salCompanyAccountDefaults')
export const orderFlowItemClient = unboundResourceClient('scmOrderFlowItems')

export const salesReconciliationCommandAdapter = unboundCommandAdapter({
  confirm: { target: 'row', affectedResources: ['salReconciliationItems', 'salDeliveryItems'] },
  unconfirm: { target: 'row', affectedResources: ['salReconciliationItems', 'salDeliveryItems'] },
  audit: { target: 'row', affectedResources: ['salReconciliationItems', 'salDeliveryItems', 'accGlEntries'] },
  void: { target: 'row', affectedResources: ['salReconciliationItems', 'salDeliveryItems', 'accGlEntries'] },
})
export const purchaseReconciliationCommandAdapter = unboundCommandAdapter({
  confirm: { target: 'row', affectedResources: ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems'] },
  unconfirm: { target: 'row', affectedResources: ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems'] },
  audit: { target: 'row', affectedResources: ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems', 'accGlEntries'] },
  void: { target: 'row', affectedResources: ['purReconciliationItems', 'purReceiptItems', 'purOutsourcedReceiptItems', 'accGlEntries'] },
})
