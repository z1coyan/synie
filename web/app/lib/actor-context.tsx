import { createContext, useContext, useMemo, type ReactNode } from 'react'

export interface CurrentActorAccess {
  user: { id: string; username: string; name: string | null }
  superAdmin: boolean
  allCompanies: boolean
  permissions: readonly string[]
  companyIds: readonly string[]
}

const CurrentActorContext = createContext<CurrentActorAccess | null>(null)

export function CurrentActorProvider({ value, children }: { value: CurrentActorAccess; children: ReactNode }) {
  return <CurrentActorContext.Provider value={value}>{children}</CurrentActorContext.Provider>
}

export function useCurrentActor(): CurrentActorAccess {
  const value = useContext(CurrentActorContext)
  if (!value) throw new Error('当前页面缺少 Actor 上下文')
  return value
}

export function useCurrentPermissions(): ReadonlySet<string> {
  const actor = useCurrentActor()
  return useMemo(() => {
    const permissions = new Set(actor.permissions)
    if (actor.superAdmin) permissions.add('*')
    return permissions
  }, [actor.permissions, actor.superAdmin])
}
