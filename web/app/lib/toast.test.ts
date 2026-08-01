import { describe, expect, mock, test } from 'bun:test'

// mock @heroui/react 的 toast,断言 toastError 实际发出的 danger 调用
// 注意:必须先拿到真实模块再整体展开,bun test 同进程内 mock 全局生效,
// 只给部分导出会导致其他测试文件链接 Spinner/AlertDialog 等导出失败
const actual = await import('@heroui/react')
const dangerCalls: Array<{ label: string; description: string }> = []
mock.module('@heroui/react', () => ({
  ...actual,
  toast: {
    danger: (label: string, opts: { description: string }) => {
      dangerCalls.push({ label, description: opts.description })
    },
  },
}))

const { errorMessage, toastError } = await import('./toast')

describe('errorMessage', () => {
  test('Error 取 message', () => {
    expect(errorMessage(new Error('网络超时'))).toBe('网络超时')
  })

  test('非 Error 一律 String 化', () => {
    expect(errorMessage('纯字符串')).toBe('纯字符串')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('toastError', () => {
  test('返回 (e: unknown) => void 回调', () => {
    expect(typeof toastError('重置密码失败')).toBe('function')
  })

  test('catch 回调形态:label 作标题,Error.message 作描述', () => {
    dangerCalls.length = 0
    toastError('重置密码失败')(new Error('用户不存在'))
    expect(dangerCalls).toEqual([{ label: '重置密码失败', description: '用户不存在' }])
  })

  test('非 Error 异常走 String 化描述', () => {
    dangerCalls.length = 0
    toastError('加载失败')('boom')
    expect(dangerCalls).toEqual([{ label: '加载失败', description: 'boom' }])
  })

  test('.catch(toastError(...)) 形态:拒绝的 Promise 被吞掉并发出提示', async () => {
    dangerCalls.length = 0
    await Promise.reject(new Error('服务端 500')).catch(toastError('权限信息加载失败'))
    expect(dangerCalls).toEqual([{ label: '权限信息加载失败', description: '服务端 500' }])
  })
})
