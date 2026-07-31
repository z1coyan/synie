import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import { resourceListBody } from './resource-wire'
import type { ResourceClient, ResourceTransport } from './types'

export const fileClient = {
  id: 'rest:sysFiles',
  async query(input) {
    const result = await apiData(
      api.files.query.$post({
        json: resourceListBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.files[':id'].metadata.$get({ param: { id } }),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.files[':id'].$delete({ param: { id } }),
    )
  },
} satisfies ResourceTransport

export const storageClient: ResourceClient = {
  id: 'rest:sysStorages',
  async query(input) {
    const result = await apiData(
      api.system.storages.query.$post({
        json: resourceListBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.system.storages[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.system.storages.$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.system.storages[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.system.storages[':id'].$delete({ param: { id } }),
    )
  },
}

export async function setDefaultStorage(id: string): Promise<void> {
  await apiData(
    api.system.storages[':id']['set-default'].$post({
      param: { id }}),
  )
}

/** sysStorages 语义命令：setDefault 为 row target；transport 仅在此 Adapter */
export const storageCommandAdapter = createCommandAdapter({
  setDefault: defineCommand('row', async (input: unknown) => {
    const id = decodeRowTarget(input)
    await setDefaultStorage(id)
  }),
})

export async function queryAttachments(input: Record<string, unknown>) {
  return apiData(
    api.files.attachments.query.$post({ json: input as never }),
  )
}

export async function deleteAttachment(id: string): Promise<void> {
  await apiData(
    api.files.attachments[':id'].$delete({ param: { id } }),
  )
}
