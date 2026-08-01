import { apiData, api } from '../api/client'
import { restTransport } from './rest-transport'
import type { Row } from '~/components/synie-data-grid/types'

type AccountTemplate = 'CAS' | 'SMALL' | 'INTL'

export const accountClient = restTransport('basAccounts', api.base.accounts)

/**
 * 按公司 + 科目角色查询启用中的非汇总科目；role 只传 bas_account_role 枚举常量。
 * 恰好一个 → 调用方自动带科目;零个/多个 → 调用方提示手选。
 */
export async function findRoleAccounts(companyId: string, role: string): Promise<Row[]> {
  const data = await accountClient.query({
    limit: 10,
    offset: 0,
    filter: {
      companyId: {
        kind: 'fk',
        values: [companyId],
        labels: [companyId],
      },
      isGroup: { kind: 'bool', eq: false },
      active: { kind: 'bool', eq: true },
      role: { kind: 'enum', values: [role] },
    },
  })
  return data.results
}

export async function initializeAccountTemplate(companyId: string, template: AccountTemplate) {
  return apiData(
    api.base.accounts['init-template'].$post({
      json: { companyId, template },
    }),
  )
}
