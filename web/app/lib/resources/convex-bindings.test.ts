import { describe, expect, test } from 'bun:test'
import type { ConvexReactClient } from 'convex/react'
import { createConvexBindingResolver, createConvexTodoSemanticOperations } from './convex-bindings'

function fakeClient() {
  const calls: Array<{ kind: 'query' | 'mutation'; args: unknown }> = []
  const client = {
    async query(_reference: unknown, args: unknown) {
      calls.push({ kind: 'query', args })
      return {
        results: [{ id: 'opaque-convex-id', name: '人民币', isoCode: 'CNY' }],
        pageInfo: { continueCursor: 'opaque-next-cursor', isDone: false },
      }
    },
    async mutation(_reference: unknown, args: unknown) {
      calls.push({ kind: 'mutation', args })
      return 3
    },
  } as unknown as ConvexReactClient
  return { client, calls }
}

describe('Convex ResourceBinding', () => {
  test('resolver 暴露已验收闭包，未知资源 fail-closed', () => {
    const { client } = fakeClient()
    const resolve = createConvexBindingResolver(client)
    expect(resolve('basCurrencies').resource).toBe('basCurrencies')
    expect(resolve('basUnits').resource).toBe('basUnits')
    expect(resolve('invWarehouses').resource).toBe('invWarehouses')
    expect(resolve('basCompanies').resource).toBe('basCompanies')
    expect(resolve('sysUsers').commands).toBeDefined()
    expect(resolve('salSettings').writer).toBeDefined()
    expect(resolve('salOrders').draft).toBeDefined()
    expect(resolve('salOrders').writer?.create).toBeUndefined()
    expect(resolve('salOrders').writer?.update).toBeUndefined()
    expect(resolve('salOrders').writer?.delete).toBeDefined()
    expect(resolve('accBankReconciliations').writer?.delete).toBeDefined()
    expect(() => resolve('unknownResource')).toThrow(/尚未迁移到 Convex/)
  })

  test('reader 原样传递 opaque cursor，且不伪造 totalCount', async () => {
    const { client, calls } = fakeClient()
    const page = await createConvexBindingResolver(client)('basCurrencies').reader.query({
      profile: 'default',
      numItems: 2,
      cursor: 'opaque-current-cursor',
    })
    expect(calls).toEqual([{
      kind: 'query',
      args: {
        profile: 'default',
        numItems: 2,
        cursor: 'opaque-current-cursor',
      },
    }])
    expect(page.pageInfo).toEqual({ continueCursor: 'opaque-next-cursor', isDone: false })
    expect(page).not.toHaveProperty('totalCount')
  })

  test('币种搜索保留 active，未声明排序与非法布尔在调用 Convex 前失败', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('basCurrencies').reader
    await expect(reader.query({
      profile: 'default',
      numItems: 20,
      sort: { column: 'name', direction: 'ascending' },
    })).rejects.toThrow(/暂不支持/)
    await reader.query({
      profile: 'default',
      numItems: 20,
      search: 'CNY',
      filter: { active: { kind: 'bool', eq: true } },
    })
    await expect(reader.query({
      profile: 'lookup',
      numItems: 20,
      filter: { active: { kind: 'enum', values: ['true'] } },
    })).rejects.toThrow(/布尔/)
    expect(calls.map((call) => call.args)).toEqual([{
      profile: 'search',
      numItems: 20,
      cursor: null,
      search: 'CNY',
      args: { active: true },
    }])
  })

  test('领域页面的固定排序、父范围与月份解析为有限 query profile', async () => {
    const { client, calls } = fakeClient()
    const resolve = createConvexBindingResolver(client)
    await resolve('salOrderItems').reader.query({
      profile: 'default',
      numItems: 20,
      cursor: null,
      sort: { column: 'idx', direction: 'descending' },
      fixedFilter: { orderId: { kind: 'fk', values: ['opaque-order'], labels: [] } },
    })
    await resolve('hrPayrolls').reader.query({
      profile: 'default',
      numItems: 20,
      cursor: null,
      fixedFilter: { month: { kind: 'text', op: 'eq', value: '2026-07' } },
    })
    expect(calls.map((call) => call.args)).toEqual([
      {
        resource: 'salOrderItems', numItems: 20, cursor: null,
        queryArgs: {
          parentId: 'opaque-order', sortField: 'idx', sortDirection: 'descending',
        },
      },
      {
        resource: 'hrPayrolls', numItems: 20, cursor: null,
        queryArgs: { month: '2026-07' },
      },
    ])
  })

  test('物料单位 Reader 每页都将单值 materialId filter 下发给 Convex', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('invMaterialUnits').reader

    await reader.query({
      profile: 'default',
      numItems: 100,
      cursor: null,
      filter: {
        materialId: {
          kind: 'fk',
          op: 'in',
          values: ['material-1'],
          labels: [],
        },
      },
    })
    await reader.query({
      profile: 'default',
      numItems: 80,
      cursor: 'material-units/next',
      fixedFilter: {
        materialId: {
          kind: 'fk',
          op: 'in',
          values: ['material-1'],
          labels: [],
        },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        numItems: 100,
        cursor: null,
        materialId: 'material-1',
      },
      {
        numItems: 80,
        cursor: 'material-units/next',
        materialId: 'material-1',
      },
    ])
  })

  test('科目 lookup、角色 lookup 与搜索逐页保持公司和候选限定', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('basAccounts').reader
    const commonFilter = {
      companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
      active: { kind: 'bool' as const, eq: true },
      isGroup: { kind: 'bool' as const, eq: false },
    }

    await reader.query({
      profile: 'lookup', numItems: 20, cursor: null,
      sort: { column: 'code', direction: 'ascending' },
      filter: commonFilter,
    })
    await reader.query({
      profile: 'lookup', numItems: 20, cursor: 'accounts/next',
      sort: { column: 'code', direction: 'ascending' },
      filter: commonFilter,
    })
    await reader.query({
      profile: 'lookup', numItems: 20, cursor: null,
      sort: { column: 'code', direction: 'ascending' },
      filter: {
        ...commonFilter,
        role: { kind: 'enum', values: ['UNBILLED_RECEIVABLE'] },
      },
    })
    await reader.query({
      profile: 'search', numItems: 20, cursor: 'accounts/search-next', search: '应收',
      sort: { column: 'code', direction: 'ascending' },
      filter: {
        ...commonFilter,
        role: { kind: 'enum', values: ['RECEIVABLE'] },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        profile: 'lookup', numItems: 20, cursor: null, companyId: 'company-1',
        active: true, isGroup: false,
      },
      {
        profile: 'lookup', numItems: 20, cursor: 'accounts/next', companyId: 'company-1',
        active: true, isGroup: false,
      },
      {
        profile: 'lookup', numItems: 20, cursor: null, companyId: 'company-1',
        active: true, isGroup: false, role: 'unbilled_receivable',
      },
      {
        profile: 'search', numItems: 20, cursor: 'accounts/search-next', search: '应收', companyId: 'company-1',
        active: true, isGroup: false, role: 'receivable',
      },
    ])
  })

  test('科目筛选非法、多值或伪排序时在调用 Convex 前 fail-closed', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('basAccounts').reader
    const invalid = [
      {},
      {
        filter: {
          companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1', 'company-2'], labels: [] },
        },
      },
      { args: { companyId: 'company-1', active: 'true' } },
      {
        filter: {
          companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
          role: { kind: 'enum' as const, values: ['RECEIVABLE', 'PAYABLE'] },
        },
      },
      {
        filter: {
          companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
          role: { kind: 'enum' as const, values: ['NOT_A_ROLE'] },
        },
      },
      {
        filter: {
          companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
        },
        sort: { column: 'name' as const, direction: 'ascending' as const },
      },
      {
        filter: {
          companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
        },
        sort: { column: 'code' as const, direction: 'descending' as const },
      },
    ]

    for (const query of invalid) {
      await expect(reader.query({
        profile: 'lookup', numItems: 20,
        ...query,
      } as never)).rejects.toThrow(/暂不支持|公司范围|单值|布尔|角色|升序/)
    }
    expect(calls).toEqual([])
  })

  test('科目与物料分类树查询接受根层 isNil 及各自固定升序', async () => {
    const { client, calls } = fakeClient()
    const resolve = createConvexBindingResolver(client)

    await resolve('basAccounts').reader.query({
      profile: 'treeChildren', numItems: 100, cursor: null,
      args: { parentId: null },
      sort: { column: 'code', direction: 'ascending' },
      filter: {
        parentId: { kind: 'fk', op: 'isNil', values: [], labels: [] },
      },
      fixedFilter: {
        companyId: { kind: 'fk', values: ['company-1'], labels: [] },
      },
    })
    await resolve('invMaterialCategories').reader.query({
      profile: 'treeChildren', numItems: 100, cursor: null,
      args: { parentId: null },
      sort: { column: 'code', direction: 'ascending' },
      filter: {
        parentId: { kind: 'fk', op: 'isNil', values: [], labels: [] },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        profile: 'treeChildren', numItems: 100, cursor: null,
        companyId: 'company-1', parentId: null,
      },
      {
        profile: 'treeChildren', numItems: 100, cursor: null,
        parentId: null,
      },
    ])
  })

  test('物料分类 lookup/search 只保留非叶或启用叶候选限定', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('invMaterialCategories').reader

    await reader.query({
      profile: 'lookup', numItems: 20,
      filter: { isLeaf: { kind: 'bool', eq: false } },
    })
    await reader.query({
      profile: 'search', numItems: 20, cursor: 'category/next', search: '原料',
      filter: {
        active: { kind: 'bool', eq: true },
        isLeaf: { kind: 'bool', eq: true },
      },
    })
    await expect(reader.query({
      profile: 'lookup', numItems: 20,
      filter: { active: { kind: 'bool', eq: true } },
    })).rejects.toThrow(/候选/)

    expect(calls.map((call) => call.args)).toEqual([
      {
        profile: 'lookup', numItems: 20, cursor: null,
        isLeaf: false,
      },
      {
        profile: 'search', numItems: 20, cursor: 'category/next', search: '原料',
        active: true, isLeaf: true,
      },
    ])
  })

  test('领域 Reader 将普通单值 FK filter 解析为父范围 query profile', async () => {
    const { client, calls } = fakeClient()
    await createConvexBindingResolver(client)('mfgOutputItems').reader.query({
      profile: 'default',
      numItems: 100,
      cursor: null,
      sort: { column: 'idx', direction: 'ascending' },
      filter: {
        outputId: {
          kind: 'fk',
          op: 'in',
          values: ['output-1'],
          labels: [],
        },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        resource: 'mfgOutputItems',
        numItems: 100,
        cursor: null,
        queryArgs: {
          parentId: 'output-1',
          sortField: 'idx',
          sortDirection: 'ascending',
        },
      },
    ])
  })

  test('领域 Reader 对多值状态在调用 Convex 前 fail-closed', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('salOrders').reader

    await expect(reader.query({
      profile: 'default',
      numItems: 20,
      filter: {
        status: { kind: 'enum', values: ['DRAFT', 'AUDITED'] },
      },
    })).rejects.toThrow(/单值枚举/)

    expect(calls).toEqual([])
  })

  test('BOM 候选将单值物料 FK 与状态一起下推', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('mfgBoms').reader

    await reader.query({
      profile: 'lookup',
      numItems: 20,
      filter: {
        materialId: {
          kind: 'fk', op: 'in', values: ['material-1'], labels: [],
        },
        status: { kind: 'enum', values: ['ACTIVE'] },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([{
      resource: 'mfgBoms',
      numItems: 20,
      cursor: null,
      queryArgs: {
        candidateProfile: 'bomByMaterial',
        materialId: 'material-1',
        status: 'ACTIVE',
      },
    }])
  })

  test('BOM 候选对多值物料 FK fail-closed，不得退化为跨物料查询', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('mfgBoms').reader

    await expect(reader.query({
      profile: 'lookup',
      numItems: 20,
      filter: {
        materialId: {
          kind: 'fk', op: 'in', values: ['material-1', 'material-2'], labels: [],
        },
      },
    })).rejects.toThrow(/单值外键/)

    expect(calls).toEqual([])
  })

  test('制造选择器下推需求行与工单候选 profile，并允许需求行按交期排序', async () => {
    const { client, calls } = fakeClient()
    const resolve = createConvexBindingResolver(client)
    const companyFilter = {
      companyId: {
        kind: 'fk' as const,
        op: 'in' as const,
        values: ['company-1'],
        labels: [],
      },
    }

    await resolve('mfgDemandItems').reader.query({
      profile: 'default',
      numItems: 20,
      sort: { column: 'needDate', direction: 'ascending' },
      fixedFilter: {
        candidatePurpose: {
          kind: 'enum',
          values: ['WORK_ORDER'],
        },
      },
    })
    await resolve('mfgWorkOrders').reader.query({
      profile: 'default',
      numItems: 20,
      sort: { column: 'needDate', direction: 'ascending' },
      fixedFilter: {
        ...companyFilter,
        candidatePurpose: {
          kind: 'enum',
          values: ['OUTPUT'],
        },
      },
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        resource: 'mfgDemandItems',
        numItems: 20,
        cursor: null,
        queryArgs: {
          candidateProfile: 'demandItemWorkOrder',
        },
      },
      {
        resource: 'mfgWorkOrders',
        numItems: 20,
        cursor: null,
        queryArgs: {
          candidateProfile: 'workOrderOutput',
          companyId: 'company-1',
        },
      },
    ])
  })

  test('生产需求行普通列表支持页面声明的 needDate 默认排序', async () => {
    const { client, calls } = fakeClient()

    await createConvexBindingResolver(client)('mfgDemandItems').reader.query({
      profile: 'default',
      numItems: 20,
      sort: { column: 'needDate', direction: 'ascending' },
    })

    expect(calls.map((call) => call.args)).toEqual([{
      resource: 'mfgDemandItems',
      numItems: 20,
      cursor: null,
      queryArgs: {
        sortField: 'needDate',
        sortDirection: 'ascending',
      },
    }])
  })

  test('父范围来源优先级保持 args 高于 fixedFilter 高于 filter', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('mfgOutputItems').reader
    const filter = {
      outputId: {
        kind: 'fk' as const,
        op: 'in' as const,
        values: ['from-filter'],
        labels: [],
      },
    }

    await reader.query({
      profile: 'default',
      numItems: 20,
      args: { outputId: 'from-args' },
      fixedFilter: { outputId: 'from-fixed' },
      filter,
    })
    await reader.query({
      profile: 'default',
      numItems: 20,
      fixedFilter: { outputId: 'from-fixed' },
      filter,
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        resource: 'mfgOutputItems',
        numItems: 20,
        cursor: null,
        queryArgs: { parentId: 'from-args' },
      },
      {
        resource: 'mfgOutputItems',
        numItems: 20,
        cursor: null,
        queryArgs: { parentId: 'from-fixed' },
      },
    ])
  })

  test('非法或多值父范围在调用 Convex 前 fail-closed', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('mfgOutputItems').reader
    const invalid = [
      {
        filter: {
          outputId: {
            kind: 'fk' as const,
            op: 'in' as const,
            values: ['output-1', 'output-2'],
            labels: [],
          },
        },
      },
      {
        filter: {
          outputId: {
            kind: 'fk' as const,
            op: 'isNil' as const,
            values: [],
            labels: [],
          },
        },
      },
      {
        fixedFilter: {
          outputId: {
            kind: 'fk',
            values: ['output-1', 'output-2'],
            labels: [],
          },
        },
      },
      { args: { outputId: null } },
    ]

    for (const query of invalid) {
      await expect(
        reader.query({
          profile: 'default',
          numItems: 20,
          ...query,
        }),
      ).rejects.toThrow(/单值/)
    }
    expect(calls).toEqual([])
  })

  test('领域 binding 对未声明 fixedFilter 和排序 fail-closed', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('salOrders').reader
    await expect(reader.query({
      profile: 'default', numItems: 20,
      fixedFilter: { partyId: { kind: 'fk', values: ['opaque-party'], labels: [] } },
    })).rejects.toThrow(/暂不支持/)
    await expect(reader.query({
      profile: 'default', numItems: 20,
      sort: { column: 'grossTotal', direction: 'descending' },
    })).rejects.toThrow(/暂不支持/)
    expect(calls).toEqual([])
  })

  test('仓库 lookup/search 逐页保留公司、启用与叶子限定', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('invWarehouses').reader
    const filter = {
      companyId: { kind: 'fk' as const, op: 'in' as const, values: ['company-1'], labels: [] },
      active: { kind: 'bool' as const, eq: true },
      isLeaf: { kind: 'bool' as const, eq: true },
    }

    await reader.query({
      profile: 'lookup', numItems: 20, cursor: null, filter,
    })
    await reader.query({
      profile: 'search', numItems: 20, cursor: 'warehouse/next',
      search: '原料', filter,
    })

    expect(calls.map((call) => call.args)).toEqual([
      {
        profile: 'lookup', numItems: 20, cursor: null,
        args: { companyId: 'company-1', active: true, isLeaf: true },
      },
      {
        profile: 'search', numItems: 20, cursor: 'warehouse/next', search: '原料',
        args: { companyId: 'company-1', active: true, isLeaf: true },
      },
    ])
  })

  test('仓库树只接受 name 升序，非法候选组合在请求前失败', async () => {
    const { client, calls } = fakeClient()
    const reader = createConvexBindingResolver(client)('invWarehouses').reader

    await reader.query({
      profile: 'treeChildren', numItems: 100, cursor: null,
      args: { parentId: null },
      sort: { column: 'name', direction: 'ascending' },
      fixedFilter: {
        companyId: { kind: 'fk', op: 'in', values: ['company-1'], labels: [] },
      },
    })
    await expect(reader.query({
      profile: 'lookup', numItems: 20,
      filter: {
        companyId: { kind: 'fk', values: ['company-1'], labels: [] },
        active: { kind: 'bool', eq: true },
      },
    })).rejects.toThrow(/active.*isLeaf|isLeaf.*active|同时/)
    await expect(reader.query({
      profile: 'treeChildren', numItems: 20,
      args: { parentId: null },
      sort: { column: 'name', direction: 'descending' },
      fixedFilter: { companyId: 'company-1' },
    })).rejects.toThrow(/升序/)

    expect(calls.map((call) => call.args)).toEqual([{
      profile: 'treeChildren', numItems: 100, cursor: null,
      args: { companyId: 'company-1', parentId: null },
    }])
  })

  test('仓库 collection command 经语义 Adapter 调用 seed mutation', async () => {
    const { client, calls } = fakeClient()
    const commands = createConvexBindingResolver(client)('invWarehouses').commands!
    await expect(commands.execute('seedDefaults', { companyId: 'opaque-company-id' })).resolves.toBe(3)
    expect(calls).toEqual([{
      kind: 'mutation',
      args: { companyId: 'opaque-company-id' },
    }])
  })

  test('角色权限命令按单页 100 沿 opaque cursor 拉完', async () => {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      async query(_reference: unknown, args: Record<string, unknown>) {
        calls.push(args)
        if (!('roleId' in args)) return { groups: ['系统'] }
        if (Number(args.numItems) > 100) {
          throw new Error('每页条数必须是 1..100 的整数')
        }
        return args.cursor == null
          ? {
              results: [{ id: 'permission-1' }],
              pageInfo: { continueCursor: 'permissions/next', isDone: false },
            }
          : {
              results: [{ id: 'permission-2' }],
              pageInfo: { continueCursor: null, isDone: true },
            }
      },
      async mutation() {
        return null
      },
    } as unknown as ConvexReactClient

    const command = createConvexBindingResolver(client)('sysRoles').commands!
    await expect(
      command.execute('loadPermissions', { id: 'role-1' }),
    ).resolves.toEqual({
      catalog: { groups: ['系统'] },
      rows: [{ id: 'permission-1' }, { id: 'permission-2' }],
    })
    expect(calls.filter((args) => 'roleId' in args)).toEqual([
      { roleId: 'role-1', numItems: 100, cursor: null },
      { roleId: 'role-1', numItems: 100, cursor: 'permissions/next' },
    ])
  })
})

describe('Convex Todo semantic operations', () => {
  test('limit 只接受 1..100 的整数，并在调用 Convex 前拒绝非法值', async () => {
    const { client, calls } = fakeClient()
    const operations = createConvexTodoSemanticOperations(client)

    await expect(operations.list('active', { limit: 101 })).rejects.toThrow(
      /limit 必须是 1\.\.100 的整数/,
    )
    expect(calls).toEqual([])

    await operations.list('active', { limit: 100 })
    expect(calls).toEqual([{
      kind: 'query',
      args: {
        tab: 'active',
        includeDismissed: false,
        numItems: 100,
        cursor: null,
      },
    }])
  })
})
