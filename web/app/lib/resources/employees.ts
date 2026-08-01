import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const employeeClient = restTransport('hrEmployees', api.hr.employees, {
  strictListLabel: '员工',
  decimalFields: ['dailyWage', 'monthlyAllowance'],
})
