import { describe, expect, test } from 'bun:test'
import { aggregateDraftTransport } from './aggregate-draft-transport'

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

function fakeDraftEndpoints() {
  const calls: {
    load: Call[]
    create: Call[]
    replace: Call[]
  } = { load: [], create: [], replace: [] }
  const endpoints = {
    $post: (args: unknown) => {
      calls.create.push({ args })
      return Promise.resolve(fakeResponse({ id: 'draft-1', items: [] }))
    },
    ':id': {
      $put: (args: unknown) => {
        calls.replace.push({ args })
        return Promise.resolve(fakeResponse({ id: 'draft-1', items: [] }))
      },
      draft: {
        $get: (args: unknown) => {
          calls.load.push({ args })
          return Promise.resolve(
            fakeResponse({ id: 'draft-1', items: [{ id: 'i1' }] }),
          )
        },
      },
    },
  }
  return { endpoints, calls }
}

describe('aggregateDraftTransport', () => {
  test('loadDraft 走 :id/draft GET 且 param 携带 id', async () => {
    const { endpoints, calls } = fakeDraftEndpoints()
    const adapter = aggregateDraftTransport(endpoints)
    const saved = await adapter.loadDraft('doc-9')
    expect(saved).toEqual({ id: 'draft-1', items: [{ id: 'i1' }] })
    expect(calls.load).toEqual([{ args: { param: { id: 'doc-9' } } }])
    expect(calls.create).toEqual([])
    expect(calls.replace).toEqual([])
  })

  test('createDraft 走集合 POST，body 原样提交', async () => {
    const { endpoints, calls } = fakeDraftEndpoints()
    const adapter = aggregateDraftTransport<
      { companyId: string },
      { id: string; items: unknown[] }
    >(endpoints)
    const input = { companyId: 'c1' }
    const saved = await adapter.createDraft(input)
    expect(saved).toEqual({ id: 'draft-1', items: [] })
    expect(calls.create).toEqual([{ args: { json: input } }])
  })

  test('replaceDraft 走 :id PUT，param 与 body 齐全', async () => {
    const { endpoints, calls } = fakeDraftEndpoints()
    const adapter = aggregateDraftTransport<
      { companyId: string },
      { id: string; items: unknown[] }
    >(endpoints)
    const input = { companyId: 'c1' }
    await adapter.replaceDraft('doc-9', input)
    expect(calls.replace).toEqual([
      { args: { param: { id: 'doc-9' }, json: input } },
    ])
  })

  test('options.wire 仅作用于 create/replace，load 不经 wire', async () => {
    const { endpoints, calls } = fakeDraftEndpoints()
    const wired: unknown[] = []
    const adapter = aggregateDraftTransport<{ qty: number }, { id: string }>(
      endpoints,
      {
        wire: (input) => {
          wired.push(input)
          return { qty: String(input.qty) }
        },
      },
    )

    await adapter.loadDraft('doc-1')
    expect(wired).toEqual([])

    await adapter.createDraft({ qty: 3 })
    await adapter.replaceDraft('doc-1', { qty: 5 })
    expect(wired).toEqual([{ qty: 3 }, { qty: 5 }])
    expect(calls.create[0]?.args).toEqual({ json: { qty: '3' } })
    expect(calls.replace[0]?.args).toEqual({
      param: { id: 'doc-1' },
      json: { qty: '5' },
    })
  })

  test('具备 loadDraft / createDraft / replaceDraft 三方法', () => {
    const { endpoints } = fakeDraftEndpoints()
    const adapter = aggregateDraftTransport(endpoints)
    expect(typeof adapter.loadDraft).toBe('function')
    expect(typeof adapter.createDraft).toBe('function')
    expect(typeof adapter.replaceDraft).toBe('function')
    expect(adapter).not.toHaveProperty('form')
    expect(adapter).not.toHaveProperty('query')
  })
})
