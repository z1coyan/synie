import { useEffect, useState } from 'react'
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
  catalog: CatalogGroup[]
  rows: GrantedRow[]
}

// roleId 为服务端签发的 uuid,内插进查询串(同 remote-query.ts 的 filter 先例)。
// list 统一 offset 分页(backend/CLAUDE.md);limit 200 = max_page_size,权限行数量级远小于此,一页取足。
const loadQuery = (roleId: string) => `
  query {
    permissionCatalog { prefix actions }
    sysRolePermissions(filter: { roleId: { eq: "${roleId}" } }, limit: 200, offset: 0) {
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
        setData({ catalog: res.permissionCatalog, rows: res.sysRolePermissions.results })
        setChecked(initialChecked(res.permissionCatalog, res.sysRolePermissions.results))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, roleId, reloadKey])

  const toggle = (code: string, selected: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (selected) next.add(code)
      else next.delete(code)
      return next
    })

  const save = async () => {
    if (!data || !roleId) return
    const diff = buildDiff(data.catalog, data.rows, checked)
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
        try {
          const res = await gqlFetch<{ destroySysRolePermission: { errors: { message: string }[] | null } }>(
            DESTROY,
            { id }
          )
          if (res.destroySysRolePermission.errors?.length) failed.push(`删除失败(行 ${id})`)
        } catch {
          failed.push(`删除失败(行 ${id})`)
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

  const columns = data ? actionColumns(data.catalog) : []

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className="w-full lg:w-[720px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>配置权限:{props.roleName}</Sheet.Heading>
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
              ) : !data ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {groupByDomain(data.catalog).map((bucket) => (
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
                <Button onPress={save} isPending={saving} isDisabled={!data}>
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
