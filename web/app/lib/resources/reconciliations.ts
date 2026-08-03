import { apiData, api } from '../api/client'
import { createRowCommandAdapter } from './catalog/commands'
import { restTransport } from './rest-transport'

async function salesAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      api.sales.reconciliations[':id'].confirm.$post({
        param: { id }}),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      api.sales.reconciliations[':id'].unconfirm.$post({
        param: { id }}),
    )
  }
  if (action === 'audit') {
    return apiData(
      api.sales.reconciliations[':id'].audit.$post({
        param: { id }}),
    )
  }
  return apiData(
    api.sales.reconciliations[':id'].void.$post({
      param: { id }}),
  )
}

async function purchaseAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      api.purchase.reconciliations[':id'].confirm.$post({
        param: { id }}),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      api.purchase.reconciliations[':id'].unconfirm.$post({
        param: { id }}),
    )
  }
  if (action === 'audit') {
    return apiData(
      api.purchase.reconciliations[':id'].audit.$post({
        param: { id }}),
    )
  }
  return apiData(
    api.purchase.reconciliations[':id'].void.$post({
      param: { id }}),
  )
}

export const salesReconciliationCommandAdapter = createRowCommandAdapter({
  confirm: {
    handler: (id) => salesAction(id, 'confirm'),
    affectedResources: ['salReconciliationItems', 'salDeliveryItems'],
  },
  unconfirm: {
    handler: (id) => salesAction(id, 'unconfirm'),
    affectedResources: ['salReconciliationItems', 'salDeliveryItems'],
  },
  audit: {
    handler: (id) => salesAction(id, 'audit'),
    affectedResources: [
      'salReconciliationItems',
      'salDeliveryItems',
      'accGlEntries',
    ],
  },
  void: {
    handler: (id) => salesAction(id, 'void'),
    affectedResources: [
      'salReconciliationItems',
      'salDeliveryItems',
      'accGlEntries',
    ],
  },
})

export const purchaseReconciliationCommandAdapter = createRowCommandAdapter({
  confirm: {
    handler: (id) => purchaseAction(id, 'confirm'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
    ],
  },
  unconfirm: {
    handler: (id) => purchaseAction(id, 'unconfirm'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
    ],
  },
  audit: {
    handler: (id) => purchaseAction(id, 'audit'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
      'accGlEntries',
    ],
  },
  void: {
    handler: (id) => purchaseAction(id, 'void'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
      'accGlEntries',
    ],
  },
})

export const salesReconciliationClient = restTransport(
  'salReconciliations',
  api.sales.reconciliations,
)

export const salesReconciliationItemClient = restTransport(
  'salReconciliationItems',
  api.sales['reconciliation-items'],
  { decimalFields: ['qty'] },
)

export const purchaseReconciliationClient = restTransport(
  'purReconciliations',
  api.purchase.reconciliations,
)

export const purchaseReconciliationItemClient = restTransport(
  'purReconciliationItems',
  api.purchase['reconciliation-items'],
  { decimalFields: ['qty'] },
)

export const companyAccountDefaultClient = restTransport(
  'salCompanyAccountDefaults',
  api.sales['company-account-defaults'],
  { capabilities: { delete: false } },
)

export const orderFlowItemClient = restTransport(
  'scmOrderFlowItems',
  api.base['order-flow-items'],
  { capabilities: { create: false, update: false, delete: false } },
)
