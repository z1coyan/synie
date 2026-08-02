import { describe, expect, test } from 'bun:test'
import {
  parseRecordDrawerSearch,
  recordDrawerOpenPatch,
  RECORD_DRAWER_CLOSE_PATCH,
  RECORD_DRAWER_NEW,
} from './use-record-drawer-url'

const ID = '123e4567-e89b-42d3-a456-426614174000'

describe('parseRecordDrawerSearch', () => {
  test('无 record 参数 → null(抽屉关闭,行为与现状一致)', () => {
    expect(parseRecordDrawerSearch({})).toBeNull()
    expect(parseRecordDrawerSearch({ q: '螺丝', page: 2 })).toBeNull()
  })

  test('record 为空串或非字符串 → null', () => {
    expect(parseRecordDrawerSearch({ record: '' })).toBeNull()
    expect(parseRecordDrawerSearch({ record: 42 })).toBeNull()
  })

  test('record=new → create 态,mode 参数忽略', () => {
    expect(parseRecordDrawerSearch({ record: 'new' })).toEqual({
      mode: 'create',
      recordId: null,
    })
    expect(parseRecordDrawerSearch({ record: 'new', mode: 'edit' })).toEqual({
      mode: 'create',
      recordId: null,
    })
  })

  test('record=<id> 缺省 view;仅 mode=edit 时 edit', () => {
    expect(parseRecordDrawerSearch({ record: ID })).toEqual({
      mode: 'view',
      recordId: ID,
    })
    expect(parseRecordDrawerSearch({ record: ID, mode: 'edit' })).toEqual({
      mode: 'edit',
      recordId: ID,
    })
  })

  test('mode 非法值一律回落 view(非法值不产生 edit 深链)', () => {
    expect(parseRecordDrawerSearch({ record: ID, mode: 'create' })).toEqual({
      mode: 'view',
      recordId: ID,
    })
    expect(parseRecordDrawerSearch({ record: ID, mode: 'bogus' })).toEqual({
      mode: 'view',
      recordId: ID,
    })
  })

  test('mode 单独存在(无 record)不构成抽屉状态', () => {
    expect(parseRecordDrawerSearch({ mode: 'edit' })).toBeNull()
  })
})

describe('recordDrawerOpenPatch', () => {
  test('view/edit 写 record=<id>&mode', () => {
    expect(recordDrawerOpenPatch({ mode: 'view', recordId: ID })).toEqual({
      record: ID,
      mode: 'view',
    })
    expect(recordDrawerOpenPatch({ mode: 'edit', recordId: ID })).toEqual({
      record: ID,
      mode: 'edit',
    })
  })

  test('create 写 record=new 并以 undefined 落掉 mode 键', () => {
    const patch = recordDrawerOpenPatch({ mode: 'create', recordId: null })
    expect(patch.record).toBe(RECORD_DRAWER_NEW)
    expect('mode' in patch && patch.mode === undefined).toBe(true)
  })

  test('recordId 缺失时按 create 处理(不产生 record=undefined 以外的脏 URL)', () => {
    expect(recordDrawerOpenPatch({ mode: 'view', recordId: null })).toEqual({
      record: RECORD_DRAWER_NEW,
      mode: undefined,
    })
  })

  test('并入 prev 时保留未知参数(Grid 筛选等),绝不整包替换', () => {
    const prev: Record<string, unknown> = {
      q: '螺丝',
      'f.status': 'ACTIVE',
      page: 3,
    }
    const next = {
      ...prev,
      ...recordDrawerOpenPatch({ mode: 'edit', recordId: ID }),
    }
    expect(next).toEqual({ ...prev, record: ID, mode: 'edit' })
  })
})

describe('RECORD_DRAWER_CLOSE_PATCH', () => {
  test('关闭清掉 record/mode 两键,保留未知参数', () => {
    const prev = { q: '螺丝', record: ID, mode: 'edit', page: 2 }
    const next = { ...prev, ...RECORD_DRAWER_CLOSE_PATCH }
    expect(next.q).toBe('螺丝')
    expect(next.page).toBe(2)
    // undefined 键在序列化时落掉;这里断言键被置 undefined 而非残留旧值
    expect(next.record).toBeUndefined()
    expect(next.mode).toBeUndefined()
  })

  test('关闭补丁覆盖打开补丁(同一次并入语义可预期)', () => {
    const prev = { record: ID, mode: 'view' }
    const next = { ...prev, ...RECORD_DRAWER_CLOSE_PATCH }
    expect(parseRecordDrawerSearch(next)).toBeNull()
  })
})

describe('parse ↔ patch 往返', () => {
  test('打开补丁写入后再解析回到同一抽屉状态', () => {
    for (const state of [
      { mode: 'create' as const, recordId: null },
      { mode: 'view' as const, recordId: ID },
      { mode: 'edit' as const, recordId: ID },
    ]) {
      const merged = { ...recordDrawerOpenPatch(state) }
      // mode: undefined 序列化落掉后再解析
      const serialized = Object.fromEntries(
        Object.entries(merged).filter(([, v]) => v !== undefined),
      )
      expect(parseRecordDrawerSearch(serialized)).toEqual(state)
    }
  })
})
