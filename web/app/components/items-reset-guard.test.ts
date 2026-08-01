import { describe, expect, test } from 'bun:test'
import {
  fingerprintOf,
  itemsResetGuardStep,
  type ItemsResetGuardState,
} from './items-reset-guard'

const IDLE: ItemsResetGuardState = { armed: false, baseline: '' }

describe('fingerprintOf', () => {
  test('按字段顺序取值拼接,空值一律空串', () => {
    expect(fingerprintOf({ companyId: 'c1', partyId: 'p1' }, ['companyId', 'partyId'])).toBe('c1|p1')
    expect(fingerprintOf({ companyId: 'c1' }, ['companyId', 'partyId'])).toBe('c1|')
    expect(fingerprintOf({ companyId: null, partyId: undefined }, ['companyId', 'partyId'])).toBe('|')
  })

  test('非字符串值 String 化', () => {
    expect(fingerprintOf({ n: 42, b: true }, ['n', 'b'])).toBe('42|true')
  })
})

describe('itemsResetGuardStep', () => {
  test('create 态首帧布防,以当前指纹为基线,不清行', () => {
    const r = itemsResetGuardStep(IDLE, 'create', 'c1|p1', null)
    expect(r).toEqual({ state: { armed: true, baseline: 'c1|p1' }, reset: false })
  })

  test('create 态布防后指纹变化:清行并把新指纹记为基线', () => {
    const armed = { armed: true, baseline: 'c1|p1' }
    const r1 = itemsResetGuardStep(armed, 'create', 'c2|p1', null)
    expect(r1).toEqual({ state: { armed: true, baseline: 'c2|p1' }, reset: true })
    // 同一指纹不再重复清行
    const r2 = itemsResetGuardStep(r1.state, 'create', 'c2|p1', null)
    expect(r2.reset).toBe(false)
  })

  test('edit 态行主数据未回填(rowFp 不一致或为 null)时不布防', () => {
    // 行还没到(rowFp null)
    expect(itemsResetGuardStep(IDLE, 'edit', '|', null)).toEqual({ state: IDLE, reset: false })
    // 行到了但草稿指纹与行不一致(回填进行中)
    expect(itemsResetGuardStep(IDLE, 'edit', '|', 'c1|p1')).toEqual({ state: IDLE, reset: false })
  })

  test('edit 态草稿回填成行值(指纹一致)才布防,之后再变才清行', () => {
    const r1 = itemsResetGuardStep(IDLE, 'edit', 'c1|p1', 'c1|p1')
    expect(r1).toEqual({ state: { armed: true, baseline: 'c1|p1' }, reset: false })
    const r2 = itemsResetGuardStep(r1.state, 'edit', 'c2|p1', 'c1|p1')
    expect(r2.reset).toBe(true)
    expect(r2.state.baseline).toBe('c2|p1')
  })

  test('view 态永不布防也永不清行', () => {
    expect(itemsResetGuardStep(IDLE, 'view', 'c1', 'c1')).toEqual({ state: IDLE, reset: false })
    const armed = { armed: true, baseline: 'c1' }
    expect(itemsResetGuardStep(armed, 'view', 'c2', 'c1')).toEqual({ state: armed, reset: false })
  })
})
