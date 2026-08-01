export type CompanyScopedActor = {
  superAdmin: boolean
  allCompanies: boolean
  companyIds: readonly string[]
}

export function companyFilter(actor: CompanyScopedActor | null): {
  bypass: boolean
  ids: readonly string[]
} {
  if (!actor) return { bypass: false, ids: [] }
  if (actor.superAdmin || actor.allCompanies) return { bypass: true, ids: [] }
  return { bypass: false, ids: actor.companyIds }
}

export function canAccessCompany(actor: CompanyScopedActor | null, companyId: string): boolean {
  if (!actor) return false
  return actor.superAdmin || actor.allCompanies || actor.companyIds.includes(companyId)
}
