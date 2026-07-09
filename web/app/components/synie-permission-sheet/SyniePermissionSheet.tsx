import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Spinner, Table, toast } from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { actionColumns, buildDiff, groupByDomain, initialChecked } from './matrix'
import type { CatalogGroup, GrantedRow } from './matrix'
import { actionLabel, domainLabel, resourceLabel } from './permission-labels'

export interface SyniePermissionSheetProps {
  roleId: string
  roleName: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 页面按 myPermissions 判后传入:true 时矩阵只读、无保存钮 */
  readOnly?: boolean
}

interface Loaded {
  roleId: string
  catalog: CatalogGroup[]
  rows: GrantedRow[]
}

// roleId 内插进查询串,JSON.stringify 转义(同 remote-query.ts buildOptionsQuery/buildByIdQuery 的转义先例)。
// list 统一 offset 分页(backend/CLAUDE.md);limit 200 = max_page_size,权限行数量级远小于此,一页取足。
const loadQuery = (roleId: string) => `
  query {
    permissionCatalog { prefix actions }
    sysRolePermissions(filter: { roleId: { eq: ${JSON.stringify(roleId)} } }, limit: 200, offset: 0) {
      count
      results { id permission }
    }
  }
`

const CREATE = `
  mutation ($input: CreateSysRolePermissionInput!) {
    createSysRolePermission(input: $input) { result { id } errors { message } }
  }
`
const DESTROY = `
  mutation ($id: ID!) {
    destroySysRolePermission(id: $id) { errors { message } }
  }
`

export function SyniePermissionSheet(props: SyniePermissionSheetProps) {
  const { roleId, isOpen } = props
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 关闭动画期间冻结最后一次打开时的角色名:onOpenChange(false) 后父级常把 roleName 跟着
  // 置空(见 roles.tsx 的 setPermRole(null)),若标题实时跟 props,会在 Sheet 退出动画播放期间
  // 闪成「配置权限:」空名。isOpen 为 true 时把 roleName 存入 ref;isOpen 为 false 时标题改读
  // ref 里的快照(从未打开过则退回当前 props),同 SynieRecordDrawer 的 lastOpenRef 模式。
  const lastRoleNameRef = useRef(props.roleName)
  if (isOpen) lastRoleNameRef.current = props.roleName
  const displayRoleName = isOpen ? props.roleName : lastRoleNameRef.current

  // 打开/换角色/手动重试时重拉;关闭时保留旧数据无碍(重开必然重拉)
  useEffect(() => {
    if (!isOpen || !roleId) return
    let cancelled = false
    setData(null)
    setError(null)
    gqlFetch<{
      permissionCatalog: CatalogGroup[]
      sysRolePermissions: { count: number; results: GrantedRow[] }
    }>(loadQuery(roleId))
      .then((res) => {
        if (cancelled) return
        const { count, results } = res.sysRolePermissions
        // limit 200 = max_page_size;count 超出已取回行数说明单页被截断,若照常渲染会把没
        // 取到的授权行当成"未授予"展示,勾选/保存都会 fail-open 地把它们错误回收掉。
        if (count > results.length) {
          setError('权限行数超出单页容量(200),请联系开发处理')
          return
        }
        setData({ roleId, catalog: res.permissionCatalog, rows: results })
        setChecked(initialChecked(res.permissionCatalog, results))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, roleId, reloadKey])

  // 换角色时 props.roleId 先于 setData(null) 生效的那一帧,data 仍是上一个角色的:isOpen 为
  // true 时用 data.roleId === roleId 兜底,不匹配就当未加载(走 Spinner 分支),避免闪出上一
  // 角色的勾选;不在渲染期 setState,effect 稍后会自然把 data 重置为 null 再重拉。isOpen 为
  // false(退场动画中)时 roleId 常同步被父级置空,不做该校验,沿用旧数据保持画面不闪空。
  const loaded = isOpen ? (data && data.roleId === roleId ? data : null) : data

  const toggle = (code: string, selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (selected) next.add(code)
      else next.delete(code)
      return next
    })

  const save = async () => {
    if (!loaded || !roleId) return
    const diff = buildDiff(loaded.catalog, loaded.rows, checked)
    if (diff.toCreate.length === 0 && diff.toDestroyIds.length === 0) {
      props.onOpenChange(false)
      return
    }
    setSaving(true)
    const failed: string[] = []
    // ponytail: 前端逐条并发、聚合报错;量大或需事务性时后端加 bulk action 再切
    await Promise.all([
      ...diff.toCreate.map(async (code) => {
        try {
          const res = await gqlFetch<{ createSysRolePermission: { errors: { message: string }[] | null } }>(
            CREATE,
            { input: { roleId, permission: code } }
          )
          if (res.createSysRolePermission.errors?.length) failed.push(code)
        } catch {
          failed.push(code)
        }
      }),
      ...diff.toDestroyIds.map(async (id) => {
        const code = loaded.rows.find((r) => r.id === id)?.permission ?? id
        try {
          const res = await gqlFetch<{ destroySysRolePermission: { errors: { message: string }[] | null } }>(
            DESTROY,
            { id }
          )
          if (res.destroySysRolePermission.errors?.length) failed.push(`回收失败:${code}`)
        } catch {
          failed.push(`回收失败:${code}`)
        }
      }),
    ])
    setSaving(false)
    if (failed.length > 0) {
      toast.danger('权限保存部分失败', { description: failed.join('、') })
      setReloadKey((k) => k + 1) // 重拉真实勾选态,Sheet 不关
    } else {
      toast.success('权限已保存')
      props.onOpenChange(false)
    }
  }

  const columns = loaded ? actionColumns(loaded.catalog) : []

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[720px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>配置权限:{displayRoleName}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {error ? (
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>权限数据加载失败</EmptyState.Title>
                    <EmptyState.Description>{error}</EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button variant="secondary" onPress={() => setReloadKey((k) => k + 1)}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : !loaded ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {groupByDomain(loaded.catalog).map((bucket) => (
                    <section key={bucket.domain}>
                      <h3 className="mb-2 text-sm font-medium text-ink-500">{domainLabel(bucket.domain)}</h3>
                      <Table>
                        <Table.ScrollContainer>
                          <Table.Content aria-label={`${domainLabel(bucket.domain)}权限`}>
                            <Table.Header>
                              <Table.Column isRowHeader>资源</Table.Column>
                              {columns.map((a) => (
                                <Table.Column key={a}>{actionLabel(a)}</Table.Column>
                              ))}
                            </Table.Header>
                            <Table.Body>
                              {bucket.groups.map((g) => (
                                <Table.Row key={g.prefix}>
                                  <Table.Cell>{resourceLabel(g.prefix)}</Table.Cell>
                                  {columns.map((a) => {
                                    const code = `${g.prefix}:${a}`
                                    return (
                                      <Table.Cell key={a}>
                                        {g.actions.includes(a) ? (
                                          <Checkbox
                                            aria-label={code}
                                            isSelected={checked.has(code)}
                                            isDisabled={props.readOnly || saving}
                                            onChange={(selected: boolean) => toggle(code, selected)}
                                          >
                                            <Checkbox.Content>
                                              <Checkbox.Control>
                                                <Checkbox.Indicator />
                                              </Checkbox.Control>
                                            </Checkbox.Content>
                                          </Checkbox>
                                        ) : (
                                          <span className="text-ink-500">—</span>
                                        )}
                                      </Table.Cell>
                                    )
                                  })}
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Content>
                        </Table.ScrollContainer>
                      </Table>
                    </section>
                  ))}
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
