import { describe, expect, test } from 'bun:test'
import {
  ATTACHMENT_IMAGES_COLUMN,
  buildDefaultOrder,
  moveVisibleColumn,
  moveVisibleColumnTo,
  parseColumnPrefs,
  resolveColumnSettingsEnabled,
  resolveVisibleOrder,
  toggleColumnVisible,
} from './column-prefs'

describe('parseColumnPrefs', () => {
  test('合法 v1', () => {
    expect(parseColumnPrefs({ v: 1, order: ['a', 'b'] })).toEqual({ v: 1, order: ['a', 'b'] })
  })
  test('空 order / 非法 → null', () => {
    expect(parseColumnPrefs(null)).toBeNull()
    expect(parseColumnPrefs({ v: 1, order: [] })).toBeNull()
    expect(parseColumnPrefs({ v: 2, order: ['a'] })).toBeNull()
    expect(parseColumnPrefs({ v: 1, order: [1, 'a'] })).toEqual({ v: 1, order: ['a'] })
  })
  test('保留合法 widths', () => {
    expect(parseColumnPrefs({ v: 1, order: ['a'], widths: { a: 120, b: -1, c: 'x' } })).toEqual({
      v: 1,
      order: ['a'],
      widths: { a: 120 },
    })
  })
})

describe('resolveVisibleOrder', () => {
  const candidates = ['a', 'b', 'c']
  test('无偏好用默认', () => {
    expect(resolveVisibleOrder(null, ['b', 'a'], candidates)).toEqual(['b', 'a'])
  })
  test('偏好过滤无效键', () => {
    expect(resolveVisibleOrder({ v: 1, order: ['c', 'ghost', 'a'] }, ['a'], candidates)).toEqual(['c', 'a'])
  })
  test('偏好全无效回退默认', () => {
    expect(resolveVisibleOrder({ v: 1, order: ['ghost'] }, ['b'], candidates)).toEqual(['b'])
  })
  test('默认也无效时用全候选', () => {
    expect(resolveVisibleOrder(null, ['ghost'], candidates)).toEqual(['a', 'b', 'c'])
  })
  test('新候选不自动插入偏好', () => {
    expect(resolveVisibleOrder({ v: 1, order: ['a'] }, ['a', 'b', 'c'], candidates)).toEqual(['a'])
  })
})

describe('toggle / move', () => {
  test('开列追加末尾', () => {
    expect(toggleColumnVisible(['a'], 'b', true)).toEqual(['a', 'b'])
  })
  test('最后一列不可关', () => {
    expect(toggleColumnVisible(['a'], 'a', false)).toEqual(['a'])
  })
  test('关列', () => {
    expect(toggleColumnVisible(['a', 'b'], 'a', false)).toEqual(['b'])
  })
  test('上下移', () => {
    expect(moveVisibleColumn(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveVisibleColumn(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveVisibleColumn(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })
  test('拖拽插入重排', () => {
    expect(moveVisibleColumnTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveVisibleColumnTo(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveVisibleColumnTo(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
    expect(moveVisibleColumnTo(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })
})

describe('buildDefaultOrder', () => {
  test('页面白名单 + 合成列末尾', () => {
    expect(
      buildDefaultOrder(['b', 'a'], ['a', 'b', 'c', ATTACHMENT_IMAGES_COLUMN], [ATTACHMENT_IMAGES_COLUMN]),
    ).toEqual(['b', 'a', ATTACHMENT_IMAGES_COLUMN])
  })
  test('无白名单 = 非合成候选 + 合成', () => {
    expect(buildDefaultOrder(undefined, ['a', 'b', ATTACHMENT_IMAGES_COLUMN], [ATTACHMENT_IMAGES_COLUMN])).toEqual([
      'a',
      'b',
      ATTACHMENT_IMAGES_COLUMN,
    ])
  })
})

describe('resolveColumnSettingsEnabled', () => {
  test('默认：页面开、pick 关', () => {
    expect(resolveColumnSettingsEnabled(undefined, undefined, undefined)).toBe(true)
    expect(resolveColumnSettingsEnabled(undefined, undefined, 'single')).toBe(false)
  })
  test('urlState false 关；columnSettings 可强开', () => {
    expect(resolveColumnSettingsEnabled(undefined, false, undefined)).toBe(false)
    expect(resolveColumnSettingsEnabled(true, false, 'multiple')).toBe(true)
    expect(resolveColumnSettingsEnabled(false, true, undefined)).toBe(false)
  })
})
