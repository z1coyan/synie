import { describe, expect, test } from 'bun:test'
import { arApOutputActions } from './ar-ap-output.ts'

describe('应收应付导出/打印按钮门控', () => {
  test('文档无 export/print：不显示导出与打印', () => {
    const actions = arApOutputActions({
      has: () => false,
    })
    expect(actions.canExport).toBe(false)
    expect(actions.canPrint).toBe(false)
  })

  test('有导出能力才显示导出；打印能力独立', () => {
    expect(arApOutputActions({ has: (action) => action === 'export' }).canExport).toBe(true)
    expect(arApOutputActions({ has: (action) => action === 'export' }).canPrint).toBe(false)
    expect(arApOutputActions({ has: (action) => action === 'print' }).canPrint).toBe(true)
  })
})
