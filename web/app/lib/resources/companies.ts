import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const companyClient = restTransport('basCompanies', api.base.companies, {
  strictListLabel: '公司',
})
