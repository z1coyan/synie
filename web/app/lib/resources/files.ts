import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'
import { gridMeta } from './meta'

function mergedFilter(input: { filter?: FilterState; fixedFilter?: Record<string, unknown> }) {
  return {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  } as components['schemas']['FilterState']
}

export const fileClient: ResourceClient = {
  id: 'rest:sysFiles',
  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysFiles' } },
        }),
      ),
    )
  },
  async query(input) {
    const result = await apiData(
      apiClient.POST('/files/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: mergedFilter(input),
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/files/{id}/metadata', { params: { path: { id } } }),
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
      apiClient.DELETE('/files/{id}', { params: { path: { id } } }),
    )
  },
}

export const storageClient: ResourceClient = {
  id: 'rest:sysStorages',
  async meta() {
    return gridMeta(
      await apiData(
        apiClient.GET('/meta/resources/{name}', {
          params: { path: { name: 'sysStorages' } },
        }),
      ),
    )
  },
  async query(input) {
    const result = await apiData(
      apiClient.POST('/system/storages/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: mergedFilter(input),
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/system/storages/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/system/storages', {
        body: input as components['schemas']['StorageEndpointCreate'],
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/system/storages/{id}', {
        params: { path: { id } },
        body: input as components['schemas']['StorageEndpointUpdate'],
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/system/storages/{id}', { params: { path: { id } } }),
    )
  },
}

export async function setDefaultStorage(id: string): Promise<void> {
  await apiData<void>(
    apiClient.POST('/system/storages/{id}/set-default', {
      params: { path: { id } },
    }),
  )
}

export async function queryAttachments(input: components['schemas']['AttachmentQuery']) {
  return apiData(apiClient.POST('/files/attachments/query', { body: input }))
}

export async function deleteAttachment(id: string): Promise<void> {
  await apiData<void>(
    apiClient.DELETE('/files/attachments/{id}', { params: { path: { id } } }),
  )
}
