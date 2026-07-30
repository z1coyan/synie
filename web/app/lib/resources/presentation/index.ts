export type { PresentationExtension, PresentationExtraContent, PresentationFactory } from './types'
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
