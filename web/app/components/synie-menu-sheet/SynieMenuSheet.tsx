import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Chip, toast } from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { QueryState } from '../synie-query-state/QueryState'
import { fetchRoleMenus, syncRoleMenus } from '~/lib/resources/iam'
import { menuModules } from '~/lib/menu'
import { triState } from '../synie-permission-sheet/matrix'
import {
  effectiveCount,
  groupLeafCodes,
  moduleLeafCodes,
  orphanCodes,
  serializeChecked,
  withoutOrphans,
} from './menu-tree'

export interface SynieMenuSheetProps {
  roleId: string
  roleName: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 页面按 myPermissions 判后传入:true 时树只读、无保存钮 */
  readOnly?: boolean
}

interface Loaded {
  roleId: string
  menuCodes: string[]
}

/**
 * 角色菜单白名单配置 Sheet：三级菜单树勾选（叶子落库、父级三态仅批量快捷）。
 * 空集合 = 未配置 = 全部可见；已失效 code 不自动删，提示 + 一键清理。
 * 纯导航呈现层配置，不影响任何权限码判定。
 */
export function SynieMenuSheet(props: SynieMenuSheetProps) {
  const { roleId, isOpen } = props
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 关闭动画期间冻结角色名（同 SyniePermissionSheet 的 lastRoleNameRef 模式）
  const lastRoleNameRef = useRef(props.roleName)
  if (isOpen) lastRoleNameRef.current = props.roleName
  const displayRoleName = isOpen ? props.roleName : lastRoleNameRef.current

  useEffect(() => {
    if (!isOpen || !roleId) return
    let cancelled = false
    setData(null)
    setError(null)
    fetchRoleMenus(roleId)
      .then((res) => {
        if (cancelled) return
        const menuCodes = (res as { menuCodes: string[] }).menuCodes
        setData({ roleId, menuCodes })
        setChecked(new Set(menuCodes))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, roleId, reloadKey])

  // 换角色那一帧 data 仍是上一角色的：isOpen 时用 roleId 匹配兜底（同权限 Sheet 模式）
  const loaded = isOpen ? (data && data.roleId === roleId ? data : null) : data

  const toggle = (code: string, selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (selected) next.add(code)
      else next.delete(code)
      return next
    })

  const toggleMany = (codes: string[], selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const c of codes) {
        if (selected) next.add(c)
        else next.delete(c)
      }
      return next
    })

  const save = async () => {
    if (!loaded || !roleId) return
    setSaving(true)
    try {
      await syncRoleMenus(roleId, serializeChecked(checked))
      toast.success('菜单已保存')
      props.onOpenChange(false)
    } catch (e) {
      // 目录外菜单码等字段级错误逐个点名（APIError.fields），其余落通用 message
      const err = e as Error & { fields?: Record<string, string[]> }
      const detail = err.fields
        ? Object.values(err.fields).flat().join('；')
        : err.message
      toast.danger('菜单保存失败', { description: detail })
      setReloadKey((k) => k + 1) // 重拉真实勾选态,Sheet 不关
    } finally {
      setSaving(false)
    }
  }

  const disabled = props.readOnly || saving
  const limited = checked.size > 0
  const orphans = loaded ? orphanCodes(checked, menuModules) : []

  const triCheck = (label: string, codes: string[]) => {
    const state = triState(codes, checked)
    return (
      <Checkbox
        aria-label={label}
        isSelected={state === 'all'}
        isIndeterminate={state === 'some'}
        isDisabled={disabled || codes.length === 0}
        onChange={(selected: boolean) => toggleMany(codes, selected)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
    )
  }

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[760px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>配置菜单:{displayRoleName}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {error ? (
                <QueryState
                  error={{ message: error }}
                  errorTitle="菜单数据加载失败"
                  onRetry={() => setReloadKey((k) => k + 1)}
                />
              ) : !loaded ? (
                <QueryState isPending />
              ) : (
                <div className="flex flex-col gap-5">
                  {/* 状态行：未配置（全部可见）/ 已限制 N 项 + 一键清空 */}
                  <div className="flex flex-wrap items-center gap-3">
                    {limited ? (
                      <Chip size="sm" variant="soft" color="accent">
                        已限制 {effectiveCount(checked, menuModules)} 项
                      </Chip>
                    ) : (
                      <Chip size="sm" variant="soft">
                        未配置
                      </Chip>
                    )}
                    <span className="text-xs text-ink-500">
                      {limited
                        ? '该角色用户仅见勾选的菜单；勾光即恢复全部可见'
                        : '该角色菜单不作限制，全部菜单可见'}
                    </span>
                    {!props.readOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={disabled || !limited}
                        onPress={() => setChecked(new Set())}
                      >
                        清空恢复全部可见
                      </Button>
                    )}
                  </div>

                  {/* 已失效项：白名单里有、当前菜单树已不存在的 code */}
                  {orphans.length > 0 && (
                    <div className="rounded-lg border border-ink-900/10 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">已失效 {orphans.length} 项</span>
                        {!props.readOnly && (
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={disabled}
                            onPress={() => setChecked((prev) => withoutOrphans(prev, menuModules))}
                          >
                            一键清理
                          </Button>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-500">
                        以下菜单码已不在当前菜单中（菜单已删除或改名）；不清理也会原样保留，不影响其余配置
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {orphans.map((code) => (
                          <Chip key={code} size="sm" variant="soft">
                            {code}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 菜单树：模块 → 组 → 菜单项（仅叶子落库） */}
                  <div className="flex flex-col gap-6">
                    {menuModules.map((m) => {
                      const mCodes = moduleLeafCodes(m)
                      const mChecked = mCodes.filter((c) => checked.has(c)).length
                      return (
                        <section key={m.key}>
                          <div className="flex items-center gap-1.5">
                            {triCheck(`全选${m.label}`, mCodes)}
                            <span className="text-sm font-medium">{m.label}</span>
                            <Chip size="sm" variant="soft" className="ml-1">
                              {mChecked}/{mCodes.length}
                            </Chip>
                          </div>
                          <div className="mt-2 flex flex-col gap-3 pl-7">
                            {m.groups.map((g, i) => (
                              <div key={g.label ?? i}>
                                {g.label && (
                                  <div className="flex items-center gap-1.5">
                                    {triCheck(`全选${m.label}${g.label}`, groupLeafCodes(g))}
                                    <span className="text-xs tracking-wide text-ink-500">
                                      {g.label}
                                    </span>
                                  </div>
                                )}
                                <ul className="mt-1 grid gap-x-4 gap-y-1 pl-7 sm:grid-cols-2">
                                  {g.items.map((it) => (
                                    <li key={it.code}>
                                      <Checkbox
                                        aria-label={it.label}
                                        isSelected={checked.has(it.code)}
                                        isDisabled={disabled}
                                        onChange={(selected: boolean) => toggle(it.code, selected)}
                                      >
                                        <Checkbox.Content>
                                          <Checkbox.Control>
                                            <Checkbox.Indicator />
                                          </Checkbox.Control>
                                          <span className="text-sm">{it.label}</span>
                                        </Checkbox.Content>
                                      </Checkbox>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              <Sheet.Close>
                <Button variant="secondary" isDisabled={saving}>
                  {props.readOnly ? '关闭' : '取消'}
                </Button>
              </Sheet.Close>
              {!props.readOnly && (
                <Button onPress={save} isPending={saving} isDisabled={!loaded}>
                  保存
                </Button>
              )}
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}
