import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import type { ResourceClient } from './types'
import { gridMeta } from './meta'

function mergedFilter(input: { filter?: FilterState; fixedFilter?: Record<string, unknown> }) {
  return {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  } as FilterState
}

export const fileClient: ResourceClient = {
  id: 'rest:sysFiles',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'sysFiles' }}),
      ),
    )
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.files.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: mergedFilter(input)} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.files[':id'].metadata.$get({ param: { id } }),
    )) as Row
  },
  async create() {
    throw new Error('文件请通过上传入口创建')
  },
  async update() {
    throw new Error('文件对象不可修改')
  },
  async delete(id) {
    await apiData<void>(
      api.files[':id'].$delete({ param: { id } }),
    )
  },
}

export const storageClient: ResourceClient = {
  id: 'rest:sysStorages',
  async meta() {
    return gridMeta(
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
          param: { name: 'sysStorages' }}),
      ),
    )
  },
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.system.storages.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: mergedFilter(input)} }),
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
    await apiData<void>(
      api.system.storages[':id'].$delete({ param: { id } }),
    )
  },
}

export async function setDefaultStorage(id: string): Promise<void> {
  await apiData<void>(
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
  return apiData<{
    count: number
    results: Array<{
      id: string
      category: string
      insertedAt: string
      ownerType?: string
      ownerId?: string
      file?: { id: string; filename: string; contentType: string | null; size: number } | null
    }>
  }>(api.files.attachments.query.$post({ json: input as never }))
}

export async function deleteAttachment(id: string): Promise<void> {
  await apiData<void>(
    api.files.attachments[':id'].$delete({ param: { id } }),
  )
}
