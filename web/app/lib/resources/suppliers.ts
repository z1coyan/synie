import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const supplierClient = restTransport('purSuppliers', api.base.suppliers, {
  strictListLabel: '供应商',
})
