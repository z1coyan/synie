import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceListBody } from './resource-wire'
import type { ResourceClient } from './types'

type AccountCreate = Record<string, unknown>
type AccountUpdate = Record<string, unknown>
type AccountTemplate = "CAS" | "SMALL" | "INTL"

export const accountClient: ResourceClient = {
  id: 'rest:basAccounts',


  async query(input) {
    const result = await apiData(
      api.base.accounts.query.$post({
        json: resourceListBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.base.accounts[':id'].$get({ param: { id } }),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.base.accounts.$post({ json: input as never }),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.base.accounts[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },

  async delete(id) {
    await apiData(
      api.base.accounts[':id'].$delete({ param: { id } }),
    )
  },
}

export async function initializeAccountTemplate(companyId: string, template: AccountTemplate) {
  return apiData(
    api.base.accounts['init-template'].$post({
      json: { companyId, template },
    }),
  )
}
