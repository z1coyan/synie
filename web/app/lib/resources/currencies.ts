import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const currencyClient = restTransport('basCurrencies', api.base.currencies, {
  strictListLabel: '币种',
})
