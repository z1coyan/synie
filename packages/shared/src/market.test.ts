import { describe, expect, test } from 'bun:test'
import {
  decideMarketSchedule,
  emptyMarketScheduleState,
  parseShfeMarketSettlement,
  parseSinaMarketLastBody,
} from './market.ts'

function shanghai(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute))
}

describe('market provider pure contracts', () => {
  test('parses Sina last price and SHFE main settlement', () => {
    const body = 'var hq_str_nf_CU0="铜,1,2,3,4,5,6,7,81234.5,9,10,11,12,13,14,15,16,2026-07-31";'
    expect(parseSinaMarketLastBody(body, 'nf_CU0').price.toFixed()).toBe('81234.5')
    expect(parseShfeMarketSettlement({ o_curinstrument: [
      { PRODUCTGROUPID: 'cu', DELIVERYMONTH: '2608', SETTLEMENTPRICE: '81000', OPENINTEREST: '10' },
      { PRODUCTGROUPID: 'cu', DELIVERYMONTH: '2609', SETTLEMENTPRICE: '82000', OPENINTEREST: '20' },
    ] }, 'CU')).toMatchObject({ deliveryMonth: '2609', openInterest: 20 })
  })

  test('persists distinct schedule slots and ignores duplicate ticks', () => {
    const config = { scheduleEnabled: true, lastIntervalMinutes: 30, settlementEnabled: true }
    const first = decideMarketSchedule(config, shanghai(2026, 7, 31, 9, 0), emptyMarketScheduleState())
    expect(first.runLasts).toBe(true)
    expect(decideMarketSchedule(config, shanghai(2026, 7, 31, 9, 1), first.next).runLasts).toBe(false)
    expect(decideMarketSchedule(config, shanghai(2026, 7, 31, 15, 30), first.next).runSettlements).toBe(true)
  })
})
