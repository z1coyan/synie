/**
 * 统一错误 Toast 小工具。
 * 替换各页面手写的 toast.danger(label, { description: (e as Error).message }),
 * 同时覆盖 .catch(toastError('X失败')) 与 catch (e) { toastError('X失败')(e) } 两种形态。
 */
import { toast } from '@heroui/react'

/** 异常取展示文案:Error 取 message,其余 String 化(与 (e as Error).message 的现状口径兼容且更稳) */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 生成「失败提示」catch 回调:label 作标题,异常文案作描述 */
export function toastError(label: string): (e: unknown) => void {
  return (e) => toast.danger(label, { description: errorMessage(e) })
}
