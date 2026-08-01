import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const unitClient = restTransport('basUnits', api.base.units)
