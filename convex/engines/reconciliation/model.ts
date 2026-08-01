import { checkedAdd, postingMonth } from '../shared'

type StockFact = {
  companyId: string
  warehouseId: string
  materialId: string
  postingDate: string
  signedBaseQty: bigint
  cancelled: boolean
}

type GlFact = {
  companyId: string
  accountId: string
  postingDate: string
  debit: bigint
  credit: bigint
  partyType: string | null
  partyId: string | null
  cancelled: boolean
}

function add(map: Map<string, bigint>, key: string, delta: bigint): void {
  map.set(key, checkedAdd(map.get(key) ?? 0n, delta))
}

export function inventoryProjectionModel(facts: readonly StockFact[]) {
  const current = new Map<string, bigint>()
  const daily = new Map<string, bigint>()
  const monthly = new Map<string, bigint>()
  for (const fact of facts) {
    if (fact.cancelled) continue
    const key = `${fact.companyId}\u0000${fact.warehouseId}\u0000${fact.materialId}`
    add(current, key, fact.signedBaseQty)
    add(daily, `${key}\u0000${fact.postingDate}`, fact.signedBaseQty)
    add(monthly, `${key}\u0000${postingMonth(fact.postingDate)}`, fact.signedBaseQty)
  }
  return { current, daily, monthly }
}

export function glProjectionModel(facts: readonly GlFact[]) {
  const accountDaily = new Map<string, { debit: bigint; credit: bigint }>()
  const accountMonthly = new Map<string, { debit: bigint; credit: bigint }>()
  const partyDaily = new Map<string, { debit: bigint; credit: bigint }>()
  const partyMonthly = new Map<string, { debit: bigint; credit: bigint }>()
  const addPair = (map: Map<string, { debit: bigint; credit: bigint }>, key: string, fact: GlFact) => {
    const old = map.get(key) ?? { debit: 0n, credit: 0n }
    map.set(key, { debit: checkedAdd(old.debit, fact.debit), credit: checkedAdd(old.credit, fact.credit) })
  }
  for (const fact of facts) {
    if (fact.cancelled) continue
    const accountKey = `${fact.companyId}\u0000${fact.accountId}`
    addPair(accountDaily, `${accountKey}\u0000${fact.postingDate}`, fact)
    addPair(accountMonthly, `${accountKey}\u0000${postingMonth(fact.postingDate)}`, fact)
    if (fact.partyType && fact.partyId) {
      const partyKey = `${accountKey}\u0000${fact.partyType}\u0000${fact.partyId}`
      addPair(partyDaily, `${partyKey}\u0000${fact.postingDate}`, fact)
      addPair(partyMonthly, `${partyKey}\u0000${postingMonth(fact.postingDate)}`, fact)
    }
  }
  return { accountDaily, accountMonthly, partyDaily, partyMonthly }
}
