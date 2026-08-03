import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const customerClient = restTransport('salCustomers', api.base.customers, {
  strictListLabel: '客户',
})
