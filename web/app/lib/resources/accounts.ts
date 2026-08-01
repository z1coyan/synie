import { apiData, api } from '../api/client'
import { restTransport } from './rest-transport'

type AccountTemplate = 'CAS' | 'SMALL' | 'INTL'

export const accountClient = restTransport('basAccounts', api.base.accounts)

export async function initializeAccountTemplate(companyId: string, template: AccountTemplate) {
  return apiData(
    api.base.accounts['init-template'].$post({
      json: { companyId, template },
    }),
  )
}
