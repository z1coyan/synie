import { defineClosureRecordApi } from '../shared/api'

const api = defineClosureRecordApi([
  'mfgOperations', 'mfgProcessTemplates', 'mfgProcessTemplateItems',
  'mfgBoms', 'mfgBomComponents', 'mfgBomRoutes', 'mfgBomByproducts',
  'mfgDemands', 'mfgDemandItems', 'mfgWorkOrders', 'mfgWorkOrderComponents',
  'mfgWorkOrderRoutes', 'mfgWorkOrderByproducts', 'mfgOutputs', 'mfgOutputItems',
])
export const get = api.get
export const list = api.list
export const create = api.create
export const update = api.update
export const remove = api.remove
