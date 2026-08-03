import { describe, expect, test } from 'bun:test'
import { formatChinaAddress } from './index'

describe('formatChinaAddress', () => {
  test('普通地级市拼接', () => {
    expect(
      formatChinaAddress({
        province: '江苏省',
        city: '苏州市',
        district: '工业园区',
        address: '星湖街 1 号',
      }),
    ).toBe('江苏省 苏州市 工业园区 星湖街 1 号')
  })

  test('直辖市省略「市辖区」层', () => {
    expect(
      formatChinaAddress({
        province: '上海市',
        city: '市辖区',
        district: '浦东新区',
        address: '张江路 1 号',
      }),
    ).toBe('上海市 浦东新区 张江路 1 号')
  })

  test('缺段仍可拼', () => {
    expect(formatChinaAddress({ province: '浙江省', address: '某处' })).toBe('浙江省 某处')
  })
})
