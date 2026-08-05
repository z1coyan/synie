import { Button, Spinner } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { isForbidden, isNotFound } from '~/lib/errors'

export interface QueryStateProps {
  /** 加载态(isPending 与 error 互斥;两者皆真时 error 优先) */
  isPending?: boolean
  /** 失败态错误;AppError forbidden(403)自动渲染无权限专属态 */
  error?: { message: string } | null
  /** 失败态重试回调;不传则不渲染重试按钮(403 态恒不渲染) */
  onRetry?: () => void
  /** 失败态标题,默认「数据加载失败」 */
  errorTitle?: string
  /** 尺寸档位:md= EmptyState h-64 + 默认重试按钮;sm= EmptyState h-32 + 小号重试按钮 */
  size?: 'md' | 'sm'
  /** 加载态容器高度类名,默认 h-32 */
  pendingClassName?: string
  /** 加载态 Spinner 尺寸,缺省用组件库默认 */
  spinnerSize?: 'sm' | 'md' | 'lg'
}

/**
 * 数据取数「加载中 / 加载失败+重试 / 403 无权限 / 404 不存在或无权查看」统一组件:
 * SynieDataGrid / SynieRecordDrawer / SynieEditableTable / SyniePermissionSheet 共用,
 * 语义与样式不得各自漂移。403/404 单独成态:醒目提示且不给重试(重试对权限与行级范围问题无意义)。
 * 两者皆不满足时渲染 null,调用方自行排列分支。
 */
export function QueryState({
  isPending = false,
  error = null,
  onRetry,
  errorTitle = '数据加载失败',
  size = 'md',
  pendingClassName = 'h-32',
  spinnerSize,
}: QueryStateProps) {
  if (error) {
    if (isForbidden(error)) {
      return (
        <EmptyState size={size} className={`${size === 'sm' ? 'h-32' : 'h-64'} justify-center`}>
          <EmptyState.Header>
            <EmptyState.Title className="text-danger">无权限访问</EmptyState.Title>
            <EmptyState.Description>当前账号没有查看这些数据的权限,请联系管理员分配。</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      )
    }
    // 行级范围不命中统一 not_found（spec §1.4，不泄露存在性）：与 forbidden 同样不给重试
    if (isNotFound(error)) {
      return (
        <EmptyState size={size} className={`${size === 'sm' ? 'h-32' : 'h-64'} justify-center`}>
          <EmptyState.Header>
            <EmptyState.Title>记录不存在或无权查看</EmptyState.Title>
            <EmptyState.Description>数据可能已被删除,或不在你的数据范围内。</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      )
    }
    return (
      <EmptyState size={size} className={`${size === 'sm' ? 'h-32' : 'h-64'} justify-center`}>
        <EmptyState.Header>
          <EmptyState.Title>{errorTitle}</EmptyState.Title>
          <EmptyState.Description>{error.message}</EmptyState.Description>
        </EmptyState.Header>
        {onRetry && (
          <EmptyState.Content>
            <Button size={size === 'sm' ? 'sm' : undefined} variant="secondary" onPress={onRetry}>
              重试
            </Button>
          </EmptyState.Content>
        )}
      </EmptyState>
    )
  }
  if (isPending) {
    return (
      <div className={`flex ${pendingClassName} items-center justify-center`}>
        <Spinner size={spinnerSize} />
      </div>
    )
  }
  return null
}
