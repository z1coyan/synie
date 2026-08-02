import { describe, expect, test } from 'bun:test'
import type { FilterState, SortState } from '@synie/shared'
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  SORT_NONE,
  encodeGridUrlPatch,
  encodeSort,
  mergeGridUrlSearch,
  parseColumnFilter,
  parseGridUrlSearch,
  parsePage,
  parsePageSize,
  parseSort,
  parseFilterState,
} from './url-grid-state'

const emptyDefaults = { sort: null as SortState | null, filters: {} as FilterState }

describe('parseSort / encodeSort', () => {
  test('缺省回落 defaultSort；none 表示显式无排序', () => {
    const def: SortState = { column: 'code', direction: 'ascending' }
    expect(parseSort(undefined, def)).toEqual(def)
    expect(parseSort(SORT_NONE, def)).toBeNull()
    expect(parseSort('name', null)).toEqual({ column: 'name', direction: 'ascending' })
    expect(parseSort('-insertedAt', null)).toEqual({
      column: 'insertedAt',
      direction: 'descending',
    })
  })

  test('编码：默认排序省略；显式 null 写 none', () => {
    const def: SortState = { column: 'code', direction: 'ascending' }
    expect(encodeSort(def, def)).toBeUndefined()
    expect(encodeSort(null, def)).toBe(SORT_NONE)
    expect(encodeSort(null, null)).toBeUndefined()
    expect(encodeSort({ column: 'name', direction: 'descending' }, null)).toBe('-name')
  })
})

describe('parsePage / parsePageSize', () => {
  test('非法回落默认；仅允许 10/20/50/100', () => {
    expect(parsePage(undefined)).toBe(DEFAULT_PAGE)
    expect(parsePage('3')).toBe(3)
    expect(parsePage(0)).toBe(DEFAULT_PAGE)
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageSize(50)).toBe(50)
    expect(parsePageSize(15)).toBe(DEFAULT_PAGE_SIZE)
  })
})

describe('FilterState 编解码', () => {
  test('各 kind 往返', () => {
    const filters: FilterState = {
      name: { kind: 'text', op: 'contains', value: '钢' },
      active: { kind: 'bool', eq: true },
      status: { kind: 'enum', values: ['DRAFT', 'AUDITED'] },
      tags: { kind: 'enumArray', op: 'hasAny', values: ['A'] },
      qty: { kind: 'number', op: 'between', gte: '1', lte: '10' },
      day: { kind: 'date', op: 'eq', value: '2026-08-01' },
      companyId: { kind: 'fk', values: ['u1'], labels: ['甲公司'] },
      partyId: {
        kind: 'polyFk',
        op: 'in',
        variant: 'CUSTOMER',
        values: ['c1'],
        labels: ['客户甲'],
      },
      emptyParty: { kind: 'polyFk', op: 'isNil' },
    }
    const encoded = encodeGridUrlPatch(
      { search: '', page: 1, pageSize: 20, sort: null, filters },
      emptyDefaults,
    )
    expect(typeof encoded.f).toBe('string')
    const round = parseGridUrlSearch({ f: encoded.f }, emptyDefaults)
    expect(round.filters).toEqual(filters)
  })

  test('f 缺席用 defaultFilters；f={} 表示显式清空', () => {
    const defaults: FilterState = {
      companyId: { kind: 'fk', values: ['x'], labels: ['X'] },
    }
    expect(parseGridUrlSearch({}, { sort: null, filters: defaults }).filters).toEqual(defaults)
    expect(parseGridUrlSearch({ f: '{}' }, { sort: null, filters: defaults }).filters).toEqual({})
  })

  test('坏 JSON / 非法 kind 不抛，回落默认或跳过列', () => {
    expect(parseGridUrlSearch({ f: '{bad' }, emptyDefaults).filters).toEqual({})
    expect(parseColumnFilter({ kind: 'nope' })).toBeNull()
    expect(parseFilterState({ a: { kind: 'bool', eq: true }, b: 1 })).toEqual({
      a: { kind: 'bool', eq: true },
    })
  })
})

describe('encodeGridUrlPatch / mergeGridUrlSearch', () => {
  test('默认值省略，保持无参 URL', () => {
    const patch = encodeGridUrlPatch(
      { search: '', page: 1, pageSize: 20, sort: null, filters: {} },
      emptyDefaults,
    )
    expect(patch).toEqual({
      q: undefined,
      page: undefined,
      ps: undefined,
      sort: undefined,
      f: undefined,
    })
  })

  test('非默认写入；merge 保留未知键（record/mode 等）', () => {
    const patch = encodeGridUrlPatch(
      {
        search: '轴承',
        page: 2,
        pageSize: 50,
        sort: { column: 'code', direction: 'descending' },
        filters: { active: { kind: 'bool', eq: true } },
      },
      emptyDefaults,
    )
    const merged = mergeGridUrlSearch(
      { record: 'abc', mode: 'view', tab: 'prices', q: 'old' },
      patch,
    )
    expect(merged.record).toBe('abc')
    expect(merged.mode).toBe('view')
    expect(merged.tab).toBe('prices')
    expect(merged.q).toBe('轴承')
    expect(merged.page).toBe(2)
    expect(merged.ps).toBe(50)
    expect(merged.sort).toBe('-code')
    expect(merged.f).toBe(JSON.stringify({ active: { kind: 'bool', eq: true } }))
  })

  test('清搜索时删除 q，不碰 record', () => {
    const patch = encodeGridUrlPatch(
      { search: '', page: 1, pageSize: 20, sort: null, filters: {} },
      emptyDefaults,
    )
    const merged = mergeGridUrlSearch({ q: 'old', record: 'r1' }, patch)
    expect(merged).toEqual({ record: 'r1' })
  })
})
