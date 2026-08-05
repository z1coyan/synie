/**
 * 当前登录人权限门控 hook（唯一入口，工单 14 收口）。
 *
 * 数据来自 /auth/me 的 grants（精确码 + 行级范围，无通配展开）；
 * 经 useQuery(['me']) 与 beforeLoad 的 meEnsureQuery 共缓存，不再自带 fetch。
 * pending/错误一律 fail-closed；superAdmin 恒 has=true、scopeOf='all'。
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DataScope } from '@synie/shared'
import { meEnsureQuery, type MeResponse } from '~/lib/api/session'
import { toastError } from './toast'

const DATA_SCOPES: ReadonlySet<DataScope> = new Set(['all', 'deptTree', 'dept', 'self'])

export interface MyPermissions {
  /** me 未解析（拉取中或失败）时为 true；此间 has/scopeOf 一律 fail-closed */
  pending: boolean
  isSuperAdmin: boolean
  userId: string | null
  deptId: string | null
  deptSubtreeIds: readonly string[]
  /** 精确码判定（无 candidates 展开） */
  has: (code: string) => boolean
  /** 精确码的行级范围；无授权返回 undefined */
  scopeOf: (code: string) => DataScope | undefined
}

/** MeResponse → 门控视图（纯函数，便于测试与复用）；me 缺失即 fail-closed 态 */
export function myPermissionsOf(me: MeResponse | undefined): MyPermissions {
  if (!me) {
    return {
      pending: true,
      isSuperAdmin: false,
      userId: null,
      deptId: null,
      deptSubtreeIds: [],
      has: () => false,
      scopeOf: () => undefined,
    }
  }
  // 服务端对空位集兜底 'none'（正常不出现）；防御性剔除，保持 fail-closed
  const grants = new Map(
    me.grants.filter((g) => DATA_SCOPES.has(g.scope)).map((g) => [g.code, g.scope]),
  )
  return {
    pending: false,
    isSuperAdmin: me.superAdmin,
    userId: me.user.id,
    deptId: me.departmentId,
    deptSubtreeIds: me.departmentSubtreeIds,
    has: (code) => me.superAdmin || grants.has(code),
    scopeOf: (code) => (me.superAdmin ? 'all' : grants.get(code)),
  }
}

/** 当前登录人权限门控：挂载即读 ['me'] 缓存（beforeLoad 已确保），未解析期 fail-closed */
export function useMyPermissions(): MyPermissions {
  const query = useQuery(meEnsureQuery)
  // 拉取失败仍 fail-closed，但按 web 守则给出错误回馈（对齐旧 useMyPerms 的 catch toast）
  const { isError, error } = query
  useEffect(() => {
    if (isError) toastError('权限信息加载失败')(error)
  }, [isError, error])
  return myPermissionsOf(query.data)
}
