import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  decimalWireInput,
  strictResourceListBody,
} from './resource-wire'
import type { ResourceClient } from './types'

type EmployeeCreate = Record<string, unknown>
type EmployeeUpdate = Record<string, unknown>

export const employeeClient: ResourceClient = {
  id: 'rest:hrEmployees',


  async query(input) {
    const result = await apiData(
      api.hr.employees.query.$post({
        json: strictResourceListBody(input, '员工'),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },

  async get(id) {
    return (await apiData(
      api.hr.employees[':id'].$get({
        param: { id }}),
    )) as Row
  },

  async create(input) {
    return (await apiData(
      api.hr.employees.$post({
        json: decimalWireInput(
          input,
          ['dailyWage', 'monthlyAllowance'],
        ) as never}),
    )) as Row
  },

  async update(id, input) {
    return (await apiData(
      api.hr.employees[':id'].$patch({
        param: { id },
        json: decimalWireInput(
          input,
          ['dailyWage', 'monthlyAllowance'],
        ) as never}),
    )) as Row
  },

  async delete(id) {
    await apiData(
      api.hr.employees[':id'].$delete({
        param: { id }}),
    )
  },
}
