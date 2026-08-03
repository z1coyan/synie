import { api } from '../api/client'
import { restTransport } from './rest-transport'

export const partyAddressClient = restTransport(
  'basPartyAddresses',
  api.base['party-addresses'],
  {
    strictListLabel: '地址',
  },
)

export type PartyAddressPartyType = 'CUSTOMER' | 'SUPPLIER' | 'COMPANY'
