import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from './types'
import { gridMeta } from './meta'
export const unitClient: ResourceClient = {
  id: 'rest:basUnits',
  async meta(){return gridMeta(await apiData(apiClient.GET('/meta/resources/{name}',{params:{path:{name:'basUnits'}}})))},
  async query(input){const x=await apiData(apiClient.POST('/base/units/query',{body:{limit:input.limit,offset:input.offset,search:input.search||undefined,sort:input.sort??undefined,filter:input.filter as components['schemas']['FilterState']}}));return {count:x.count,results:x.results as Row[]}},
  async get(id){return await apiData(apiClient.GET('/base/units/{id}',{params:{path:{id}}})) as Row},
  async create(input){return await apiData(apiClient.POST('/base/units',{body:input as components['schemas']['UnitCreate']})) as Row},
  async update(id,input){return await apiData(apiClient.PATCH('/base/units/{id}',{params:{path:{id}},body:input as components['schemas']['UnitUpdate']})) as Row},
  async delete(id){await apiData<void>(apiClient.DELETE('/base/units/{id}',{params:{path:{id}}}))},
}
