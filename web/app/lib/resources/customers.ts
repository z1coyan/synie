import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const customerClient = restTransport('salCustomers', api.sales.customers, {
  strictListLabel: '客户',
})
