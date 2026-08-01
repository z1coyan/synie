import { describe, expect, test } from 'bun:test'
import { restTransport } from './rest-transport'

/** 记录调用的 fake 端点；response 走 ApiResponseAdapter 最小形状。 */
function fakeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

interface Call {
  readonly args: unknown
}

function fakeCrudEndpoints() {
  const calls: { query: Call[]; get: Call[]; create: Call[]; update: Call[]; delete: Call[] } = {
    query: [],
    get: [],
    create: [],
    update: [],
    delete: [],
  }
  const endpoints = {
    query: {
      $post: (args: unknown) => {
        calls.query.push({ args })
        return Promise.resolve(fakeResponse({ count: 1, results: [{ id: 'r1' }] }))
      },
    },
    $post: (args: unknown) => {
      calls.create.push({ args })
      return Promise.resolve(fakeResponse({ id: 'r1' }))
    },
    ':id': {
      $get: (args: unknown) => {
        calls.get.push({ args })
        return Promise.resolve(fakeResponse({ id: 'r1' }))
      },
      $patch: (args: unknown) => {
        calls.update.push({ args })
        return Promise.resolve(fakeResponse({ id: 'r1' }))
      },
      $delete: (args: unknown) => {
        calls.delete.push({ args })
        return Promise.resolve(fakeResponse(undefined, 204))
      },
    },
  }
  return { endpoints, calls }
}

describe('restTransport', () => {
  test('id 遵循 rest:${resource} 缓存身份约定', () => {
    const { endpoints } = fakeCrudEndpoints()
    expect(restTransport('basUnits', endpoints).id).toBe('rest:basUnits')
  })

  test('query 默认把 fixedFilter 合并进 filter 并映射 count/results', async () => {
    const { endpoints, calls } = fakeCrudEndpoints()
    const client = restTransport('basUnits', endpoints)
    const list = await client.query({
      limit: 20,
      offset: 40,
      search: '米',
      filter: { status: { kind: 'enum', values: ['DRAFT'] } },
      fixedFilter: { unitType: { kind: 'enum', values: ['WEIGHT'] } },
    })
    expect(list).toEqual({ count: 1, results: [{ id: 'r1' }] })
    expect(calls.query[0].args).toEqual({
      json: {
        limit: 20,
        offset: 40,
        search: '米',
        sort: undefined,
        filter: {
          status: { kind: 'enum', values: ['DRAFT'] },
          unitType: { kind: 'enum', values: ['WEIGHT'] },
        },
      },
    })
  })

  test('strictListLabel 拒绝 fixedFilter 并在报错中带业务名', () => {
    const { endpoints } = fakeCrudEndpoints()
    const client = restTransport('basCurrencies', endpoints, {
      strictListLabel: '币种',
    })
    expect(
      client.query({
        limit: 10,
        offset: 0,
        fixedFilter: { active: { kind: 'enum', values: ['true'] } },
      }),
    ).rejects.toThrow('币种 REST 资源不支持 fixedFilter')
  })

  test('decimalFields 与 dateTimeFields 只作用于 create/update 的 wire body', async () => {
    const { endpoints, calls } = fakeCrudEndpoints()
    const client = restTransport('salOrders', endpoints, {
      decimalFields: ['exchangeRate'],
      dateTimeFields: ['orderDate'],
    })
    await client.create({ exchangeRate: 7.2, orderDate: '2026-08-01', note: 'n' })
    expect(calls.create[0].args).toEqual({
      json: { exchangeRate: '7.2', orderDate: '2026-08-01T00:00:00Z', note: 'n' },
    })
    await client.update('r1', { exchangeRate: '', orderDate: '2026-08-02' })
    expect(calls.update[0].args).toEqual({
      param: { id: 'r1' },
      json: { exchangeRate: null, orderDate: '2026-08-02T00:00:00Z' },
    })
  })

  test('get/delete 只传 param id', async () => {
    const { endpoints, calls } = fakeCrudEndpoints()
    const client = restTransport('basUnits', endpoints)
    await client.get('r1')
    await client.delete?.('r1')
    expect(calls.get[0].args).toEqual({ param: { id: 'r1' } })
    expect(calls.delete[0].args).toEqual({ param: { id: 'r1' } })
  })

  test('能力子集资源的写方法不存在，不生成抛错 stub', () => {
    const { endpoints } = fakeCrudEndpoints()
    const readOnly = restTransport('accGlEntries', endpoints, {
      capabilities: { create: false, update: false, delete: false },
    })
    expect('create' in readOnly).toBe(false)
    expect('update' in readOnly).toBe(false)
    expect('delete' in readOnly).toBe(false)

    const noUpdate = restTransport('sysNumberingCounters', endpoints, {
      capabilities: { create: false, delete: false },
    })
    expect('create' in noUpdate).toBe(false)
    expect('update' in noUpdate).toBe(true)
    expect('delete' in noUpdate).toBe(false)
  })

  test('声明能力但端点缺动词时装配期 fail-closed', () => {
    const readEndpoints = {
      query: { $post: () => Promise.resolve(fakeResponse({ count: 0, results: [] })) },
      ':id': { $get: () => Promise.resolve(fakeResponse({})) },
    }
    expect(() =>
      // @ts-expect-error 手写 fake 缺动词时类型层已拦截；运行时守卫兜住 JS 调用方
      restTransport('broken', readEndpoints),
    ).toThrow('rest:broken 声明了 create 能力但端点缺少 $post')
  })
})
