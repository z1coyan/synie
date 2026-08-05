/**
 * 主体抽屉「地址」tab 内容：客户 / 供应商 / 公司共用。
 * 主体尚未保存时只提示；保存后按 partyType+partyId 列表增删改。
 * 行操作走 ⋯ 菜单（同 DataGrid RowActionsMenu 惯例）。
 */
import { hasCapability } from '@synie/shared'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Spinner, Table, toast } from '@heroui/react'
import { useCatalogBasicForm, requireWriter } from '~/lib/resources/catalog'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { RowActionsMenu } from '~/components/synie-data-grid/row-menu'
import type { ResolvedAction } from '~/components/synie-data-grid/use-grid-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'
import type { PartyAddressPartyType } from '~/lib/resources/party-addresses'
import { formatChinaAddress } from '~/lib/china-regions'
import { toastError } from '~/lib/toast'
import { ChinaRegionCascade } from './ChinaRegionCascade'

const RESOURCE = 'basPartyAddresses'

/** 主体抽屉 tabs 声明（基本信息 + 地址），三页共用 */
export const PARTY_ADDRESS_DRAWER_TABS = [
  { key: 'basic', label: '基本信息' },
  { key: 'addresses', label: '地址' },
] as const

const PURPOSE_LABELS: Record<string, string> = {
  SHIPPING: '收发货',
  OFFICE: '通信办公',
  OTHER: '其他',
}

export function PartyAddressesSection(props: {
  partyType: PartyAddressPartyType
  partyId: string | undefined
  /** view 时只读；edit/create 可写（create 无 id 时本区不开放写） */
  readonly: boolean
}) {
  const { partyType, partyId, readonly } = props
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit' | 'view'; id?: string } | null>(
    null,
  )
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '地址')
  const meta = useGridMeta(RESOURCE, true)
  const can = (action: string) => hasCapability(meta.data?.capabilities ?? [], action)

  const queryKey = ['partyAddresses', partyType, partyId]
  const list = useQuery({
    queryKey,
    enabled: !!partyId,
    queryFn: async () => {
      if (!partyId) return [] as Row[]
      const result = await binding.reader.query({
        limit: 200,
        offset: 0,
        filter: {
          partyType: { kind: 'enum', values: [partyType] },
          partyId: { kind: 'fk', values: [partyId], labels: [partyId] },
        },
      })
      return result.results
    },
  })

  if (!partyId) {
    return (
      <div className="rounded-md border border-dashed border-ink-200 bg-surface-50 px-3 py-3">
        <p className="text-sm text-ink-500">请先保存主体，再维护地址。</p>
      </div>
    )
  }

  const rows = list.data ?? []
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey })
  }

  const remove = async (row: Row) => {
    try {
      const del = requireWriter(binding, 'delete', '地址')
      await del(String(row.id))
      toast.success('地址已删除')
      refresh()
    } catch (e) {
      toastError('删除地址失败')(e)
    }
  }

  const rowActions = (row: Row): ResolvedAction[] => {
    const id = String(row.id)
    const items: ResolvedAction[] = [
      {
        key: 'view',
        label: '查看',
        isDanger: false,
        run: () => setDrawer({ mode: 'view', id }),
      },
    ]
    if (!readonly && can('update')) {
      items.push({
        key: 'edit',
        label: '编辑',
        isDanger: false,
        run: () => setDrawer({ mode: 'edit', id }),
      })
    }
    if (!readonly && can('delete')) {
      items.push({
        key: 'delete',
        label: '删除',
        isDanger: true,
        run: () => void remove(row),
      })
    }
    return items
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        {!readonly && can('create') && (
          <Button size="sm" variant="secondary" onPress={() => setDrawer({ mode: 'create' })}>
            新增地址
          </Button>
        )}
      </div>

      {list.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner aria-label="加载地址" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted">暂无地址；可在本区新增收发货或办公地址。</p>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="地址列表">
              <Table.Header>
                <Table.Column isRowHeader>名称</Table.Column>
                <Table.Column>用途</Table.Column>
                <Table.Column>联系</Table.Column>
                <Table.Column>地址</Table.Column>
                <Table.Column>状态</Table.Column>
                <Table.Column className="w-12"> </Table.Column>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => {
                  const id = String(row.id)
                  const purpose = String(row.purpose ?? '')
                  const contact = [row.contactName, row.contactPhone]
                    .filter((x) => x != null && String(x).trim() !== '')
                    .join(' · ')
                  const full = formatChinaAddress({
                    province: row.province as string | null,
                    city: row.city as string | null,
                    district: row.district as string | null,
                    address: row.address as string | null,
                  })
                  return (
                    <Table.Row key={id}>
                      <Table.Cell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>{String(row.name ?? '')}</span>
                          {row.isDefault ? (
                            <Chip size="sm" variant="soft" color="accent">
                              默认
                            </Chip>
                          ) : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell>{PURPOSE_LABELS[purpose] ?? purpose}</Table.Cell>
                      <Table.Cell className="text-sm text-ink-600">{contact || '—'}</Table.Cell>
                      <Table.Cell className="max-w-[16rem] text-sm">
                        <span className="block truncate" title={full}>
                          {full || '—'}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {row.active === false ? (
                          <Chip size="sm" variant="soft">
                            停用
                          </Chip>
                        ) : (
                          <span className="text-sm text-ink-500">启用</span>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-end">
                        <RowActionsMenu items={rowActions(row)} row={row} />
                      </Table.Cell>
                    </Table.Row>
                  )
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.id}
        exclude={[
          ...(formProps.exclude ?? []),
          // 主体由外层固定，二级抽屉不让改
          'partyType',
          'partyId',
        ]}
        fields={{
          ...formProps.fields,
          name: { ...(formProps.fields?.name ?? {}), order: 0 },
          purpose: { ...(formProps.fields?.purpose ?? {}), order: 1, cols: 6 },
          isDefault: { ...(formProps.fields?.isDefault ?? {}), order: 2, cols: 6 },
          contactName: { ...(formProps.fields?.contactName ?? {}), order: 3, cols: 6 },
          contactPhone: { ...(formProps.fields?.contactPhone ?? {}), order: 4, cols: 6 },
          // 省市区：级联控件挂在 province 上，city/district 隐藏但仍校验提交
          province: {
            ...(formProps.fields?.province ?? {}),
            order: 5,
            label: '省市区',
            required: true,
            input: ({ values, patchValues, isDisabled }) => (
              <ChinaRegionCascade
                values={values}
                patchValues={patchValues}
                isDisabled={isDisabled}
                required
              />
            ),
            render: (_v, row) =>
              formatChinaAddress({
                province: row.province as string | null,
                city: row.city as string | null,
                district: row.district as string | null,
              }) || '—',
          },
          city: { ...(formProps.fields?.city ?? {}), order: 6, hidden: true, required: true },
          district: {
            ...(formProps.fields?.district ?? {}),
            order: 7,
            hidden: true,
            required: true,
          },
          address: {
            ...(formProps.fields?.address ?? {}),
            order: 8,
            label: '街道门牌',
            placeholder: '街道、门牌号、楼层等',
            required: true,
          },
          active: { ...(formProps.fields?.active ?? {}), order: 9, cols: 6 },
          remarks: { ...(formProps.fields?.remarks ?? {}), order: 10 },
        }}
        onEdit={() => drawer?.id && setDrawer({ mode: 'edit', id: drawer.id })}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const saved = await requireWriter(binding, 'create', '地址')({
              ...values,
              partyType,
              partyId,
            })
            toast.success('地址已创建')
            refresh()
            return String(saved.id)
          }
          const saved = await requireWriter(binding, 'update', '地址')(String(drawer!.id), {
            ...values,
          })
          toast.success('地址已更新')
          refresh()
          return String(saved.id)
        }}
      />
    </div>
  )
}
