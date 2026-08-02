// 菜单可见性区：自原 SynieMenuSheet 平移（树勾选/状态徽标/一键清空/失效项清理），
// 新增每个叶子项的关联权限资源注解（只读文本，可点击跳转功能权限区对应行）。
// 语义不变：空集合 = 未配置 = 全部可见；只有叶子落库；已失效 code 提示 + 一键清理。
import { Fragment } from 'react'
import { Button, Checkbox, Chip } from '@heroui/react'
import { QueryState } from '../synie-query-state/QueryState'
import { menuModules } from '~/lib/menu'
import { triState } from '../synie-permission-sheet/matrix'
import { resourceLabel } from '../synie-permission-sheet/permission-labels'
import { effectiveCount, groupLeafCodes, moduleLeafCodes, orphanCodes } from '../synie-menu-sheet/menu-tree'

export interface MenuSectionProps {
  /** null=加载中；error 与 loaded 互斥（无查看权限时本组件不被渲染） */
  loaded: { menuCodes: string[] } | null
  error: string | null
  onRetry: () => void
  checked: Set<string>
  /** 只读（无写权限/内置角色只读）：不渲染一键清空/清理按钮 */
  readOnly: boolean
  /** 交互禁用（只读或保存中） */
  disabled: boolean
  /** 功能权限区可见：注解渲染为可点击跳转链接；否则纯文本 */
  canJump: boolean
  /** 权限目录下发标签（未加载时回落静态映射） */
  catalogLabelOf: (prefix: string) => string | undefined
  onToggle: (code: string, selected: boolean) => void
  onToggleMany: (codes: string[], selected: boolean) => void
  onClear: () => void
  onCleanOrphans: () => void
  onJump: (prefix: string) => void
}

export function MenuSection(props: MenuSectionProps) {
  const { checked, disabled, readOnly } = props

  const triCheck = (label: string, codes: string[]) => {
    const state = triState(codes, checked)
    return (
      <Checkbox
        aria-label={label}
        isSelected={state === 'all'}
        isIndeterminate={state === 'some'}
        isDisabled={disabled || codes.length === 0}
        onChange={(selected: boolean) => props.onToggleMany(codes, selected)}
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
    <section aria-label="菜单可见性" className="flex flex-col gap-4">
      <p className="text-xs text-ink-500">菜单只管导航入口，不影响任何操作权限；能不能操作由「功能权限」页签决定</p>
      {props.error ? (
        <QueryState
          error={{ message: props.error }}
          errorTitle="菜单数据加载失败"
          onRetry={props.onRetry}
        />
      ) : !props.loaded ? (
        <QueryState isPending />
      ) : (
        <div className="flex flex-col gap-5">
          {/* 状态行：未配置（全部可见）/ 已限制 N 项 + 一键清空 */}
          <div className="flex flex-wrap items-center gap-3">
            {checked.size > 0 ? (
              <Chip size="sm" variant="soft" color="accent">
                已限制 {effectiveCount(checked, menuModules)} 项
              </Chip>
            ) : (
              <Chip size="sm" variant="soft">
                未配置
              </Chip>
            )}
            <span className="text-xs text-ink-500">
              {checked.size > 0
                ? '该角色用户仅见勾选的菜单；勾光即恢复全部可见'
                : '该角色菜单不作限制，全部菜单可见'}
            </span>
            {!readOnly && (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={disabled || checked.size === 0}
                onPress={props.onClear}
              >
                清空恢复全部可见
              </Button>
            )}
          </div>

          {/* 已失效项：白名单里有、当前菜单树已不存在的 code */}
          {orphanCodes(checked, menuModules).length > 0 && (
            <div className="rounded-lg border border-ink-900/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  已失效 {orphanCodes(checked, menuModules).length} 项
                </span>
                {!readOnly && (
                  <Button size="sm" variant="ghost" isDisabled={disabled} onPress={props.onCleanOrphans}>
                    一键清理
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-ink-500">
                以下菜单码已不在当前菜单中（菜单已删除或改名）；不清理也会原样保留，不影响其余配置
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {orphanCodes(checked, menuModules).map((code) => (
                  <Chip key={code} size="sm" variant="soft">
                    {code}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {/* 菜单树：模块 → 组 → 菜单项（仅叶子落库）；叶子下挂关联权限资源注解 */}
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
                            <span className="text-xs tracking-wide text-ink-500">{g.label}</span>
                          </div>
                        )}
                        <ul className="mt-1 grid gap-x-4 gap-y-2 pl-7 sm:grid-cols-2">
                          {g.items.map((it) => (
                            <li key={it.code}>
                              <Checkbox
                                aria-label={it.label}
                                isSelected={checked.has(it.code)}
                                isDisabled={disabled}
                                onChange={(selected: boolean) => props.onToggle(it.code, selected)}
                              >
                                <Checkbox.Content>
                                  <Checkbox.Control>
                                    <Checkbox.Indicator />
                                  </Checkbox.Control>
                                  <span className="text-sm">{it.label}</span>
                                </Checkbox.Content>
                              </Checkbox>
                              <div className="pl-6 text-xs leading-5 text-ink-500">
                                {it.relatedPermissions.length === 0 ? (
                                  <span>无专属权限</span>
                                ) : (
                                  <>
                                    <span>关联 </span>
                                    {it.relatedPermissions.map((p, i) => (
                                      <Fragment key={p}>
                                        {i > 0 && <span className="text-ink-300"> / </span>}
                                        {props.canJump ? (
                                          <button
                                            type="button"
                                            className="text-accent underline-offset-2 hover:underline"
                                            onClick={() => props.onJump(p)}
                                          >
                                            {resourceLabel(p, props.catalogLabelOf(p))}
                                          </button>
                                        ) : (
                                          resourceLabel(p, props.catalogLabelOf(p))
                                        )}
                                      </Fragment>
                                    ))}
                                  </>
                                )}
                              </div>
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
    </section>
  )
}
