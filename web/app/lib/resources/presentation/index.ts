export type {
  DocumentPreviewConfig,
  DocumentPreviewLineTable,
  PresentationExtension,
  PresentationExtraContent,
  PresentationFactory,
  ResourceDrawerConfig,
} from './types'
export {
  CUSTOMER_RESOURCE,
  createCustomerPresentation,
  submitCustomerForm,
} from './customer'
export {
  VAT_INVOICE_RESOURCE,
  createInvoicePresentation,
  invoiceOcrRecognize,
  submitInvoiceForm,
} from './invoice'
export {
  EMPLOYEE_RESOURCE,
  createEmployeePresentation,
  submitEmployeeForm,
} from './employee'
export {
  MATERIAL_RESOURCE,
  createMaterialPresentation,
  submitMaterialForm,
  type MaterialPresentation,
} from './material'
export {
  ACCOUNT_RESOURCE,
  createAccountPresentation,
  submitAccountForm,
} from './account'
export {
  createInventoryDocumentPresentation,
  INVENTORY_DOCUMENT_RESOURCES,
  type InventoryDocumentPresentation,
  type InventoryDocumentResource,
} from './inventory-documents'
export { listPresentationResources, presentationFor } from './registry'
