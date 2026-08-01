import { unboundResourceClient, unavailableResourceOperation } from './unbound'

export const accountClient = unboundResourceClient('basAccounts')

export async function initializeAccountTemplate(
  _companyId: string,
  _template: 'CAS' | 'SMALL' | 'INTL',
) {
  return unavailableResourceOperation()
}
