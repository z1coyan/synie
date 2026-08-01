import { createContext, useContext, type ReactNode } from 'react'
import type { ConvexReactClient } from 'convex/react'
import { MAX_RESOURCE_PAGE_SIZE } from '@synie/shared'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'
import type { Row } from '~/components/synie-data-grid/types'

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

interface OptionPage {
  results: Row[]
  pageInfo: { continueCursor: string | null; isDone: boolean }
}

/** 非 Catalog 辅助选项也必须沿服务端 opaque cursor 拉完，禁止 take 后伪造 isDone。 */
export async function readAllWarehouseSupportRows(
  loadPage: (numItems: number, cursor: string | null) => Promise<OptionPage>,
): Promise<Row[]> {
  const rows: Row[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const page = await loadPage(MAX_RESOURCE_PAGE_SIZE, cursor)
    rows.push(...page.results)
    if (page.pageInfo.isDone) return rows
    const next = page.pageInfo.continueCursor
    if (!next) throw new Error('仓库辅助选项分页未结束但缺少 continueCursor')
    if (seenCursors.has(next)) throw new Error('仓库辅助选项分页 cursor 重复')
    seenCursors.add(next)
    cursor = next
  }
}

function option(row: Row): WarehouseOption {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    ...(row.code == null || row.code === '' ? {} : { code: String(row.code) }),
  }
}

export async function loadWarehouseSupportContext(
  client: ConvexReactClient,
  companyId?: string | null,
): Promise<WarehouseSupportContext> {
  const companiesPromise = readAllWarehouseSupportRows((numItems, cursor) => client.query(
    api.domains.base.companies.list,
    { profile: 'default', numItems, cursor },
  ) as Promise<OptionPage>)
  const suppliersPromise = readAllWarehouseSupportRows((numItems, cursor) => client.query(
    api.domains.party.parties.listSuppliers,
    { profile: 'default', numItems, cursor },
  ) as Promise<OptionPage>)
  const accountsPromise = companyId
    ? readAllWarehouseSupportRows((numItems, cursor) => client.query(
        api.domains.base.accounts.list,
        { profile: 'default', numItems, cursor, companyId: companyId as never },
      ) as Promise<OptionPage>)
    : Promise.resolve([])
  const parentsPromise = companyId
    ? readAllWarehouseSupportRows((numItems, cursor) => client.query(
        api.resources.warehouses.list,
        { profile: 'default', numItems, cursor, args: { companyId } },
      ) as Promise<OptionPage>)
    : Promise.resolve([])

  const [companyRows, accountRows, supplierRows, parentRows] = await Promise.all([
    companiesPromise,
    accountsPromise,
    suppliersPromise,
    parentsPromise,
  ])
  const companies = companyRows.map(option).sort((left, right) =>
    String(left.code ?? '').localeCompare(String(right.code ?? '')),
  )
  const accounts = accountRows
    .filter((row) => row.isGroup !== true && row.currencyId == null)
    .map(option)
  const suppliers = supplierRows.map(option)
  const parents = parentRows.filter((row) => row.isLeaf === false).map(option)
  return { companies, accounts, suppliers, parents }
}

export function convexWarehouseSupport(client: ConvexReactClient): WarehouseSupportAdapter {
  return {
    id: 'convex:warehouse-support',
    load: async (companyId) => {
      try {
        return await loadWarehouseSupportContext(client, companyId)
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
