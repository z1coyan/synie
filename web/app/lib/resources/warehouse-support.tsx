import { createContext, useContext, type ReactNode } from 'react'
import type { ConvexReactClient } from 'convex/react'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'

export interface WarehouseOption {
  id: string
  name: string
  code?: string
}

export interface WarehouseSupportContext {
  companies: WarehouseOption[]
  accounts: WarehouseOption[]
  suppliers: WarehouseOption[]
  parents: WarehouseOption[]
}

export interface WarehouseSupportAdapter {
  readonly id: string
  load(companyId?: string | null): Promise<WarehouseSupportContext>
}

export function convexWarehouseSupport(client: ConvexReactClient): WarehouseSupportAdapter {
  return {
    id: 'convex:warehouse-support',
    load: async (companyId) => {
      try {
        return await client.query(api.resources.warehouses.context, { companyId: companyId ?? null })
      } catch (error) {
        throw mapConvexError(error)
      }
    },
  }
}

const Context = createContext<WarehouseSupportAdapter | null>(null)

export function WarehouseSupportProvider({ adapter, children }: { adapter: WarehouseSupportAdapter; children: ReactNode }) {
  return <Context.Provider value={adapter}>{children}</Context.Provider>
}

export function useWarehouseSupport(): WarehouseSupportAdapter {
  const adapter = useContext(Context)
  if (!adapter) throw new Error('仓库辅助能力尚未由 Convex 应用壳装配')
  return adapter
}
