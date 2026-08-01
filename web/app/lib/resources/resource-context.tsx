import { createContext, useContext, type ReactNode } from 'react'
import type { ResourceBinding } from './catalog/types'
import { resourceBindingFor as registryBindingFor } from './registry'

export type ResourceBindingResolver = (resource: string) => ResourceBinding

const ResourceBindingContext = createContext<ResourceBindingResolver | null>(null)

export function ResourceBindingProvider({
  resolve,
  children,
}: {
  resolve: ResourceBindingResolver
  children: ReactNode
}) {
  return (
    <ResourceBindingContext.Provider value={resolve}>
      {children}
    </ResourceBindingContext.Provider>
  )
}

/** 测试可使用 registry 默认绑定；生产壳注入 Convex resolver。 */
export function useResourceBinding(resource: string): ResourceBinding {
  const resolve = useContext(ResourceBindingContext) ?? registryBindingFor
  return resolve(resource)
}

export function useOptionalResourceBinding(resource: string, enabled: boolean): ResourceBinding | null {
  const resolve = useContext(ResourceBindingContext) ?? registryBindingFor
  return enabled ? resolve(resource) : null
}
