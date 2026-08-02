/**
 * 当前登录人权限门控 hook。
 * 下沉自 system/users.tsx 与 system/roles.tsx 逐字相同的
 * fetchMe().then(权限集合+superAdmin).catch(toast) 块:
 * 入口按当前用户权限门控;拉取失败按无权限处理(fail-closed)并提示。
 */
import { useEffect, useState } from 'react'
import { fetchMe, type MeResponse } from '~/lib/api/session'
import { toastError } from './toast'

export interface MyPermsState {
  myPerms: Set<string>
  isSuperAdmin: boolean
}

/** MeResponse → 门控状态(纯函数,便于测试与复用) */
export function myPermsStateOf(d: Pick<MeResponse, 'permissions' | 'superAdmin'>): MyPermsState {
  return { myPerms: new Set(d.permissions), isSuperAdmin: d.superAdmin }
}

/** 挂载时拉一次 /auth/me;失败 fail-closed(空权限集、非超管)并 toast 提示 */
export function useMyPerms(): MyPermsState {
  const [state, setState] = useState<MyPermsState>({ myPerms: new Set(), isSuperAdmin: false })

  useEffect(() => {
    fetchMe()
      .then((d) => setState(myPermsStateOf(d)))
      .catch(toastError('权限信息加载失败'))
  }, [])

  return state
}
