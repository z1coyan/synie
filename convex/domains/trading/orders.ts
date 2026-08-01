import { defineClosureRecordApi } from '../shared/api'

const api = defineClosureRecordApi([
  'salOrders', 'salOrderItems', 'purOrders', 'purOrderItems',
  'purOrderItemMaterials', 'purOrderItemByproducts',
])
export const get = api.get
export const list = api.list
export const create = api.create
export const update = api.update
export const remove = api.remove
