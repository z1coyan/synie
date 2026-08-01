import { useEffect, useMemo } from 'react'
import { convexQuery, useConvexAuth } from '@convex-dev/react-query'
import { useConvex } from 'convex/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet } from '@tanstack/react-router'
import { Button, Spinner, toast } from '@heroui/react'
import { AppShell } from './app-shell'
import { FkPreviewProvider } from './synie-record-drawer/fk-preview-provider'
import { authClient } from '~/lib/auth-client'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'
import { clearCatalogCache, setCatalogActor } from '~/lib/resources/catalog'
import {
  createConvexBindingResolver,
  createConvexAccountingSemanticOperations,
  createConvexInventorySemanticOperations,
  createConvexOrderSemanticOperations,
  createConvexFinanceBankingSemanticOperations,
  createConvexFileSemanticOperations,
  createConvexHrSemanticOperations,
  createConvexMarketSemanticOperations,
  createConvexManufacturingSemanticOperations,
  createConvexPrintingSemanticOperations,
  createConvexTodoSemanticOperations,
} from '~/lib/resources/convex-bindings'
import { activateConvexResourceBindings } from '~/lib/resources/registry'
import { activateHrSemanticOperations } from '~/lib/resources/hr-operations'
import { activateFinanceBankingSemanticOperations } from '~/lib/resources/finance-operations'
import { activateMarketSemanticOperations } from '~/lib/resources/market'
import { activateTodoSemanticOperations } from '~/lib/resources/system-ops'
import { activateManufacturingSemanticOperations } from '~/lib/resources/manufacturing'
import { ResourceBindingProvider } from '~/lib/resources/resource-context'
import { convexWarehouseSupport, WarehouseSupportProvider } from '~/lib/resources/warehouse-support'
import { CurrentActorProvider } from '~/lib/actor-context'
import { activateFileSemanticOperations } from '~/lib/files'
import { activatePrintingSemanticOperations } from '~/lib/print'
import { activateAccountingSemanticOperations } from '~/lib/resources/accounting'
import { activateInventorySemanticOperations } from '~/lib/resources/inventory'
import { activateOrderSemanticOperations } from '~/lib/resources/orders'

/** Convex-only application shell. All route resources resolve through one binding provider. */
export function ConvexAppShell() {
  const queryClient = useQueryClient()
  const convexClient = useConvex()
  const resolveBinding = useMemo(
    () => {
      const resolve = createConvexBindingResolver(convexClient)
      activateFileSemanticOperations(createConvexFileSemanticOperations(convexClient))
      activatePrintingSemanticOperations(createConvexPrintingSemanticOperations(convexClient))
      activateConvexResourceBindings(resolve)
      activateHrSemanticOperations(createConvexHrSemanticOperations(convexClient))
      activateFinanceBankingSemanticOperations(createConvexFinanceBankingSemanticOperations(convexClient))
      activateAccountingSemanticOperations(createConvexAccountingSemanticOperations(convexClient))
      activateInventorySemanticOperations(createConvexInventorySemanticOperations(convexClient))
      activateOrderSemanticOperations(createConvexOrderSemanticOperations(convexClient))
      activateMarketSemanticOperations(createConvexMarketSemanticOperations(convexClient))
      activateTodoSemanticOperations(createConvexTodoSemanticOperations(convexClient))
      activateManufacturingSemanticOperations(createConvexManufacturingSemanticOperations(convexClient))
      return resolve
    },
    [convexClient],
  )
  const warehouseSupport = useMemo(() => convexWarehouseSupport(convexClient), [convexClient])
  const auth = useConvexAuth()
  const me = useQuery({
    ...convexQuery(api.iam.me.get, {}),
    enabled: auth.isAuthenticated,
  })

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated) {
      clearCatalogCache()
      queryClient.clear()
      window.location.replace('/login')
    }
  }, [auth.isAuthenticated, auth.isLoading, queryClient])

  useEffect(() => {
    if (me.data?.user.id) setCatalogActor(String(me.data.user.id))
  }, [me.data?.user.id])

  const logout = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut()
      if (result.error) throw result.error
    },
    onSuccess: () => {
      clearCatalogCache()
      queryClient.clear()
      window.location.replace('/login')
    },
    onError: () => {
      toast.danger('退出失败', { description: '请稍后重试' })
    },
  })

  if (auth.isLoading || me.isPending || !auth.isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-porcelain">
        <Spinner size="lg" />
      </div>
    )
  }

  if (me.isError || !me.data) {
    const error = mapConvexError(me.error, '无法验证当前账号,请重新登录')
    return (
      <div className="flex min-h-screen items-center justify-center bg-porcelain px-6 text-ink-900">
        <div className="w-full max-w-md rounded-sm border border-ink-500/20 bg-white p-8 shadow-sm">
          <h1 className="font-brand text-2xl">身份验证失败</h1>
          <p className="mt-3 text-sm text-ink-500">{error.message}</p>
          <Button
            className="mt-6"
            onPress={() => window.location.replace('/login')}
          >
            返回登录
          </Button>
        </div>
      </div>
    )
  }

  return (
    <CurrentActorProvider value={{ ...me.data, user: { ...me.data.user, id: String(me.data.user.id) }, companyIds: me.data.companyIds.map(String) }}>
    <ResourceBindingProvider resolve={resolveBinding}>
    <WarehouseSupportProvider adapter={warehouseSupport}>
    <AppShell
      user={{
        username: me.data.user.username,
        name: me.data.user.name ?? null,
      }}
      onLogout={() => logout.mutate()}
    >
      <FkPreviewProvider>
          <Outlet />
      </FkPreviewProvider>
    </AppShell>
    </WarehouseSupportProvider>
    </ResourceBindingProvider>
    </CurrentActorProvider>
  )
}
