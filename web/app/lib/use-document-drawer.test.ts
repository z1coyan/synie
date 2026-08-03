import { describe, expect, test } from 'bun:test'
import {
  DocumentDetailLoader,
  type DocumentDetailState,
} from './use-document-drawer'

const ID_A = '123e4567-e89b-42d3-a456-426614174000'
const ID_B = '123e4567-e89b-42d3-a456-426614174001'

interface FakeDraft {
  headId: string
  items: string[]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function draftOf(id: string): FakeDraft {
  return { headId: id, items: [`${id}-item`] }
}

describe('DocumentDetailLoader.open', () => {
  test('open(id) 开始装载:装载中 detailLoaded=false,完成后 draft 落地且 detailLoaded=true', async () => {
    const d = deferred<FakeDraft>()
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => d.promise,
      onLoadError: () => {},
    })

    loader.open(ID_A)
    expect(loader.getState().detailLoaded).toBe(false)
    expect(loader.getState().draft).toBeNull()
    expect(loader.getState().loadedId).toBe(ID_A)

    d.resolve(draftOf(ID_A))
    await d.promise
    expect(loader.getState().draft).toEqual(draftOf(ID_A))
    expect(loader.getState().detailLoaded).toBe(true)
  })

  test('open(null)(create 态)重置:草稿清空、detailLoaded=true(空集合可提交)', () => {
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => deferred<FakeDraft>().promise,
      onLoadError: () => {},
    })
    loader.open(null)
    expect(loader.getState()).toMatchObject({
      draft: null,
      detailLoaded: true,
      loadedId: null,
    })
  })

  test('非法 id(空串/字面 undefined)触发 onOpenError,不发装载请求、回到可提交空态', () => {
    const loadCalls: string[] = []
    const openErrors: string[] = []
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => {
        loadCalls.push(id)
        return deferred<FakeDraft>().promise
      },
      onLoadError: () => {},
      onOpenError: (id) => openErrors.push(id),
    })

    loader.open('')
    loader.open('undefined')
    expect(loadCalls).toEqual([])
    expect(openErrors).toEqual(['', 'undefined'])
    expect(loader.getState()).toMatchObject({ draft: null, detailLoaded: true, loadedId: null })
  })

  test('同一 id 重复 open 会重新装载(openDrawer 语义:显式打开即重拉)', async () => {
    const loadCalls: string[] = []
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => {
        loadCalls.push(id)
        return Promise.resolve(draftOf(id))
      },
      onLoadError: () => {},
    })
    loader.open(ID_A)
    await Promise.resolve()
    loader.open(ID_A)
    await Promise.resolve()
    expect(loadCalls).toEqual([ID_A, ID_A])
  })
})

describe('DocumentDetailLoader 竞态协议', () => {
  test('快速连开两张单:先发出的慢响应被丢弃,不覆盖后一张', async () => {
    const a = deferred<FakeDraft>()
    const b = deferred<FakeDraft>()
    const queue = [a, b]
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => queue.shift()!.promise,
      onLoadError: () => {},
    })

    loader.open(ID_A)
    loader.open(ID_B)
    // A 后回:已过期,必须丢弃
    a.resolve(draftOf(ID_A))
    await a.promise
    expect(loader.getState().draft).toBeNull()
    expect(loader.getState().detailLoaded).toBe(false)
    expect(loader.getState().loadedId).toBe(ID_B)

    b.resolve(draftOf(ID_B))
    await b.promise
    expect(loader.getState().draft).toEqual(draftOf(ID_B))
    expect(loader.getState().detailLoaded).toBe(true)
  })

  test('close 作废在途请求:响应随后到达也不回填', async () => {
    const d = deferred<FakeDraft>()
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => d.promise,
      onLoadError: () => {},
    })

    loader.open(ID_A)
    loader.close()
    expect(loader.getState()).toMatchObject({
      draft: null,
      detailLoaded: true,
      loadedId: null,
    })

    d.resolve(draftOf(ID_A))
    await d.promise
    expect(loader.getState().draft).toBeNull()
    expect(loader.getState().loadedId).toBeNull()
  })

  test('装载失败:onLoadError 收到异常,draft 清空,detailLoaded 保持 false(提交被拦)', async () => {
    const d = deferred<FakeDraft>()
    const errors: unknown[] = []
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => d.promise,
      onLoadError: (e) => errors.push(e),
    })

    loader.open(ID_A)
    const failure = new Error('network down')
    d.reject(failure)
    await d.promise.catch(() => {})
    expect(errors).toEqual([failure])
    expect(loader.getState().draft).toBeNull()
    expect(loader.getState().detailLoaded).toBe(false)
  })

  test('generation 随每次 open/close 自增(供 key= 重挂载布防基线)', async () => {
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => Promise.resolve(draftOf(id)),
      onLoadError: () => {},
    })
    const g0 = loader.getState().generation
    loader.open(ID_A)
    const g1 = loader.getState().generation
    loader.close()
    const g2 = loader.getState().generation
    loader.open(null)
    const g3 = loader.getState().generation
    expect(g1).toBe(g0 + 1)
    expect(g2).toBe(g1 + 1)
    expect(g3).toBe(g2 + 1)
  })

  test('订阅者在每次状态迁移时被同步通知', async () => {
    const d = deferred<FakeDraft>()
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: () => d.promise,
      onLoadError: () => {},
    })
    const snapshots: Array<DocumentDetailState<FakeDraft>> = []
    const unsubscribe = loader.subscribe(() => snapshots.push(loader.getState()))

    loader.open(ID_A)
    d.resolve(draftOf(ID_A))
    await d.promise
    unsubscribe()
    loader.close()

    expect(snapshots.map((s) => s.detailLoaded)).toEqual([false, true])
  })
})

describe('DocumentDetailLoader.syncIdentity(URL 深链/前进后退)', () => {
  test('recordId 与已装载相同 → 不重复装载(与 open 去重,防双发)', async () => {
    const loadCalls: string[] = []
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => {
        loadCalls.push(id)
        return Promise.resolve(draftOf(id))
      },
      onLoadError: () => {},
    })
    loader.open(ID_A)
    await Promise.resolve()
    loader.syncIdentity(ID_A)
    expect(loadCalls).toEqual([ID_A])
  })

  test('recordId 变化 → 补拉新单(深链直达、前进后退切换)', async () => {
    const loadCalls: string[] = []
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => {
        loadCalls.push(id)
        return Promise.resolve(draftOf(id))
      },
      onLoadError: () => {},
    })
    loader.syncIdentity(ID_A)
    await Promise.resolve()
    loader.syncIdentity(ID_B)
    await Promise.resolve()
    expect(loadCalls).toEqual([ID_A, ID_B])
    expect(loader.getState().draft).toEqual(draftOf(ID_B))
  })

  test('recordId=null(关闭/新建) → 仅已装载时重置;未装载保持原状', async () => {
    const loader = new DocumentDetailLoader<FakeDraft>({
      loadDraft: (id) => Promise.resolve(draftOf(id)),
      onLoadError: () => {},
    })
    // 未装载:null 不产生状态迁移(generation 不变)
    const g0 = loader.getState().generation
    loader.syncIdentity(null)
    expect(loader.getState().generation).toBe(g0)

    loader.syncIdentity(ID_A)
    await Promise.resolve()
    loader.syncIdentity(null)
    expect(loader.getState()).toMatchObject({
      draft: null,
      detailLoaded: true,
      loadedId: null,
    })
  })
})
