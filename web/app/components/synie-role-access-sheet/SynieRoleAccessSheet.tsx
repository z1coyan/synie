// 「权限与菜单」统一配置抽屉（.scratch/role-access-drawer/spec.md，grill 六问定案）：
// 一个容器、两区强隔离——上「菜单可见性」区 + 下「功能权限」区，菜单树叶子项带
// 关联资源注解、点击跳转权限矩阵对应行。合并只合并容器：两套存储/端点/门控不动。
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertDialog, Button, Tabs, toast } from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import {
  fetchPermissionCatalog,
  fetchRoleMenus,
  fetchRolePermissions,
  syncRoleMenus,
  syncRolePermissions,
} from '~/lib/resources/iam'
import {
  buildSubmit,
  initialChecked,
} from '../synie-permission-sheet/matrix'
import type { CatalogGroup, GrantedRow } from '../synie-permission-sheet/matrix'
import { serializeChecked, withoutOrphans } from '../synie-menu-sheet/menu-tree'
import { menuModules } from '~/lib/menu'
import { SECTION_LABELS, domainOfPrefix, permRowId, savePlan, setsEqual } from './access-sheet'
import type { SaveSection } from './access-sheet'
import { MenuSection } from './menu-section'
import { PermissionSection } from './permission-section'

export interface AccessGates {
  /** 查看（sys.role_permission:read / sys.role_menu:read）：无则本区渲染占位、不拉数据 */
  canView: boolean
  /** 编辑（权限区 create+delete / 菜单区 update；内置角色另由 builtin 压只读） */
  canWrite: boolean
}

export interface SynieRoleAccessSheetProps {
  roleId: string
  roleName: string
  /** 内置角色：两区均只读（后端另有强制校验兜底） */
  builtin: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  perms: AccessGates
  menus: AccessGates
}

interface PermsLoaded {
  roleId: string
  catalog: CatalogGroup[]
  rows: GrantedRow[]
}

interface MenusLoaded {
  roleId: string
  menuCodes: string[]
}

/** 无查看权限区的占位：表明存在性，不泄露内容（信息可见范围与分离入口时代严格一致） */
function NoAccessPlaceholder(props: { resourceLabel: string }) {
  return (
    <EmptyState size="md" className="h-40 justify-center rounded-lg border border-dashed border-ink-900/10">
      <EmptyState.Header>
        <EmptyState.Title>无查看权限</EmptyState.Title>
        <EmptyState.Description>
          需要「{props.resourceLabel}」的查看权限才能看到本区配置
        </EmptyState.Description>
      </EmptyState.Header>
    </EmptyState>
  )
}

export function SynieRoleAccessSheet(props: SynieRoleAccessSheetProps) {
  const { roleId, isOpen } = props
  const [permsData, setPermsData] = useState<PermsLoaded | null>(null)
  const [permsError, setPermsError] = useState<string | null>(null)
  const [menusData, setMenusData] = useState<MenusLoaded | null>(null)
  const [menusError, setMenusError] = useState<string | null>(null)
  const [permChecked, setPermChecked] = useState<Set<string>>(new Set())
  const [permBaseline, setPermBaseline] = useState<Set<string>>(new Set())
  const [menuChecked, setMenuChecked] = useState<Set<string>>(new Set())
  const [menuBaseline, setMenuBaseline] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [domain, setDomain] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [jump, setJump] = useState<{ prefix: string; n: number } | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  // 两区以页签分流（照 SynieRecordDrawer 抽屉内 Tabs 先例）；默认落在菜单页签
  const [tab, setTab] = useState<'menus' | 'permissions'>('menus')

  // 关闭动画期间冻结角色名（同原两个 Sheet 的 lastRoleNameRef 模式）
  const lastRoleNameRef = useRef(props.roleName)
  if (isOpen) lastRoleNameRef.current = props.roleName
  const displayRoleName = isOpen ? props.roleName : lastRoleNameRef.current

  // 打开/换角色/手动重试时按门控各取所需；无查看权限的区不拉数据（拉了也是 403）
  useEffect(() => {
    if (!isOpen || !roleId) return
    let cancelled = false
    // 视图状态归零：页签、搜索、选中域、"更多"展开行、跳转高亮
    setTab('menus')
    setKeyword('')
    setDomain(null)
    setExpanded(new Set())
    setJump(null)

    if (props.perms.canView) {
      setPermsData(null)
      setPermsError(null)
      Promise.all([fetchPermissionCatalog(), fetchRolePermissions(roleId)])
        .then(([catalogResponse, permissionResponse]) => {
          if (cancelled) return
          const catalog = catalogResponse.groups as CatalogGroup[]
          const rows = permissionResponse.rows as unknown as GrantedRow[]
          const initial = initialChecked(catalog, rows)
          setPermsData({ roleId, catalog, rows })
          setPermChecked(initial)
          setPermBaseline(new Set(initial))
        })
        .catch((e) => {
          if (!cancelled) setPermsError((e as Error).message)
        })
    } else {
      setPermsData(null)
      setPermsError(null)
    }

    if (props.menus.canView) {
      setMenusData(null)
      setMenusError(null)
      fetchRoleMenus(roleId)
        .then((res) => {
          if (cancelled) return
          const menuCodes = (res as { menuCodes: string[] }).menuCodes
          const initial = new Set(menuCodes)
          setMenusData({ roleId, menuCodes })
          setMenuChecked(initial)
          setMenuBaseline(new Set(initial))
        })
        .catch((e) => {
          if (!cancelled) setMenusError((e as Error).message)
        })
    } else {
      setMenusData(null)
      setMenusError(null)
    }
    return () => {
      cancelled = true
    }
    // gates 在会话内稳定（/auth/me 只拉一次），不列入依赖
  }, [isOpen, roleId, reloadKey])

  // 换角色那一帧 data 仍是上一角色的：isOpen 时用 roleId 匹配兜底（同原 Sheet 模式）
  const permsLoaded = isOpen ? (permsData && permsData.roleId === roleId ? permsData : null) : permsData
  const menusLoaded = isOpen ? (menusData && menusData.roleId === roleId ? menusData : null) : menusData

  // 只读 = 无写权限或内置角色；禁用 = 只读或保存中
  const permsReadOnly = props.builtin || !props.perms.canWrite
  const menusReadOnly = props.builtin || !props.menus.canWrite

  const permsDirty = !setsEqual(permChecked, permBaseline)
  const menusDirty = !setsEqual(menuChecked, menuBaseline)
  const plan = savePlan({
    menusDirty,
    menusWritable: !menusReadOnly && menusLoaded !== null,
    permsDirty,
    permsWritable: !permsReadOnly && permsLoaded !== null,
  })

  const toggleIn =
    (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (code: string, selected: boolean) =>
      set((prev) => {
        const next = new Set(prev)
        if (selected) next.add(code)
        else next.delete(code)
        return next
      })

  const toggleManyIn =
    (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (codes: string[], selected: boolean) =>
      set((prev) => {
        const next = new Set(prev)
        for (const c of codes) {
          if (selected) next.add(c)
          else next.delete(c)
        }
        return next
      })

  const togglePerm = toggleIn(setPermChecked)
  const togglePermMany = toggleManyIn(setPermChecked)
  const toggleMenu = toggleIn(setMenuChecked)
  const toggleMenuMany = toggleManyIn(setMenuChecked)

  const toggleExpand = (prefix: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })

  // 菜单注解跳转：切到功能权限页签、清搜索、切到资源所在域，render 后 scrollIntoView 并短时高亮
  const jumpTo = (prefix: string) => {
    if (!permsLoaded) return
    setTab('permissions')
    setKeyword('')
    setDomain(domainOfPrefix(prefix))
    setJump((j) => ({ prefix, n: (j?.n ?? 0) + 1 }))
  }

  useEffect(() => {
    if (!jump) return
    document.getElementById(permRowId(jump.prefix))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = setTimeout(() => setJump(null), 1800)
    return () => clearTimeout(t)
  }, [jump])

  // 保存编排：按 savePlan 顺序提交（菜单 → 功能权限，两 sync 幂等无耦合）；
  // 成功区基线刷新为已存态，失败区保留编辑态（baseline 不动、仍 dirty 可重试），抽屉不关。
  const save = async () => {
    if (plan.length === 0 || saving) return
    setSaving(true)
    const failed: { section: SaveSection; detail: string }[] = []
    for (const section of plan) {
      try {
        if (section === 'menus') {
          await syncRoleMenus(roleId, serializeChecked(menuChecked))
          setMenuBaseline(new Set(menuChecked))
        } else {
          await syncRolePermissions(
            roleId,
            buildSubmit(permsLoaded!.catalog, permsLoaded!.rows, permChecked),
          )
          setPermBaseline(new Set(permChecked))
        }
      } catch (e) {
        // 目录外菜单码等字段级错误逐个点名（APIError.fields），其余落通用 message
        const err = e as Error & { fields?: Record<string, string[]> }
        const detail = err.fields ? Object.values(err.fields).flat().join('；') : err.message
        failed.push({ section, detail })
      }
    }
    setSaving(false)
    if (failed.length === 0) {
      toast.success('已保存')
      props.onOpenChange(false)
    } else {
      toast.danger(`保存失败：${failed.map((f) => SECTION_LABELS[f.section]).join('、')}区`, {
        description: failed.map((f) => f.detail).join('；'),
      })
    }
  }

  // 关闭拦截：保存中禁关；有未保存改动先确认（US 9）
  const requestOpenChange = (open: boolean) => {
    if (open) return props.onOpenChange(true)
    if (saving) return
    if (plan.length > 0) setConfirmClose(true)
    else props.onOpenChange(false)
  }

  const catalogLabelOf = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const g of permsLoaded?.catalog ?? []) map.set(g.prefix, g.label)
    return (prefix: string) => map.get(prefix)
  }, [permsLoaded])

  const anyWritable = !permsReadOnly || !menusReadOnly

  return (
    <>
      <Sheet isOpen={isOpen} onOpenChange={requestOpenChange} placement="right">
        <Sheet.Backdrop>
          <Sheet.Content className="w-full lg:w-[1080px]">
            <Sheet.Dialog className="h-full">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>权限与菜单:{displayRoleName}</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body>
                <Tabs
                  variant="secondary"
                  selectedKey={tab}
                  onSelectionChange={(key) => setTab(key as 'menus' | 'permissions')}
                >
                  <Tabs.ListContainer>
                    {/* 同销售订单 tabs 先例:收紧为内容宽靠左,容器全宽底边保留 */}
                    <Tabs.List aria-label="权限与菜单分区" className="w-fit min-w-0 *:w-auto">
                      <Tabs.Tab key="menus" id="menus">
                        菜单可见性
                        {menusDirty && (
                          <span
                            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent"
                            aria-label="有未保存改动"
                          />
                        )}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                      <Tabs.Tab key="permissions" id="permissions">
                        功能权限
                        {permsDirty && (
                          <span
                            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent"
                            aria-label="有未保存改动"
                          />
                        )}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>
                  {/* 只挂载当前页签的面板(同 RecordDrawer);两区状态在容器层,切换不丢 */}
                  <Tabs.Panel id={tab} className="pt-4">
                    {tab === 'menus' ? (
                      props.menus.canView ? (
                        <MenuSection
                          loaded={menusLoaded}
                          error={menusError}
                          onRetry={() => setReloadKey((k) => k + 1)}
                          checked={menuChecked}
                          readOnly={menusReadOnly}
                          disabled={menusReadOnly || saving}
                          canJump={props.perms.canView}
                          catalogLabelOf={catalogLabelOf}
                          onToggle={toggleMenu}
                          onToggleMany={toggleMenuMany}
                          onClear={() => setMenuChecked(new Set())}
                          onCleanOrphans={() => setMenuChecked((prev) => withoutOrphans(prev, menuModules))}
                          onJump={jumpTo}
                        />
                      ) : (
                        <NoAccessPlaceholder resourceLabel="角色菜单" />
                      )
                    ) : props.perms.canView ? (
                      <PermissionSection
                        loaded={permsLoaded}
                        error={permsError}
                        onRetry={() => setReloadKey((k) => k + 1)}
                        checked={permChecked}
                        disabled={permsReadOnly || saving}
                        keyword={keyword}
                        onKeywordChange={setKeyword}
                        domain={domain}
                        onDomainChange={setDomain}
                        expanded={expanded}
                        onToggle={togglePerm}
                        onToggleMany={togglePermMany}
                        onToggleExpand={toggleExpand}
                        highlightPrefix={jump?.prefix ?? null}
                      />
                    ) : (
                      <NoAccessPlaceholder resourceLabel="角色权限" />
                    )}
                  </Tabs.Panel>
                </Tabs>
              </Sheet.Body>
              <Sheet.Footer>
                {plan.length > 0 && (
                  <span className="mr-auto text-xs text-ink-500">
                    未保存：{plan.map((s) => SECTION_LABELS[s]).join('、')}
                  </span>
                )}
                <Button variant="secondary" isDisabled={saving} onPress={() => requestOpenChange(false)}>
                  {anyWritable ? '取消' : '关闭'}
                </Button>
                {anyWritable && (
                  <Button onPress={save} isPending={saving} isDisabled={plan.length === 0 || saving}>
                    保存
                  </Button>
                )}
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>

      {/* 关闭确认：任一区有未保存改动时拦截（渲染为成型元素,同 use-grid-actions 惯例） */}
      <AlertDialog.Backdrop isOpen={confirmClose} onOpenChange={(open) => !open && setConfirmClose(false)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="放弃未保存的改动?">
            {confirmClose && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>放弃未保存的改动?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>
                    {plan.map((s) => SECTION_LABELS[s]).join('、')}
                    区有未保存的改动，关闭抽屉将丢弃这些改动。
                  </p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary">
                    继续编辑
                  </Button>
                  <Button
                    variant="danger"
                    onPress={() => {
                      setConfirmClose(false)
                      props.onOpenChange(false)
                    }}
                  >
                    放弃改动
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
