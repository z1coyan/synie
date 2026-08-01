import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import { restTransport } from './rest-transport'
import { resourceListBody } from './resource-wire'
import type { ResourceTransport } from './types'

// 偏离标准形状：单条读取走 :id/metadata 而非 :id，继续手写。
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

export const storageClient = restTransport('sysStorages', api.system.storages)

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
