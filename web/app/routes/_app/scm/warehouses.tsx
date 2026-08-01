import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Label, Link, ListBox, Select, toast } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { useResourceBinding } from '~/lib/resources/resource-context'
import { useWarehouseSupport } from '~/lib/resources/warehouse-support'
import { useResourceDocument } from '~/lib/resources/catalog/use-resource-document'

export const Route = createFileRoute('/_app/scm/warehouses')({
  component: WarehousesPage,
})

// 列白名单:公司由页面顶部选定不进列,时间戳不进表格
const GRID_COLUMNS = ['name', 'parentId', 'accountId', 'isLeaf', 'isOutsourced', 'partyType', 'partyId', 'allowNegative', 'active']

/** 关联科目列:「编号-名称」,点击开科目速览(join 默认只取 id/name,code 经 joinFields 追加取回,同物料分类列先例) */
function AccountCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id = row.accountId == null || row.accountId === '' ? null : String(row.accountId)
  const account = (row.account as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  // join 缺失(科目读权限被裁剪):退截断 id,不给点不开的 link
  if (!account) return <>{id.slice(0, 8)}</>
  const text = [account.code, account.name].filter((s) => s != null && s !== '').join('-')
  return (
    <Link
      onPress={() => openPreview('basAccounts', String(account.id ?? id))}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
// 卡片:仓名标题、上级副标题、叶子/外协/启停摘要
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  name: { mobileRole: 'title' },
  parentId: { mobileRole: 'subtitle' },
  accountId: { render: (_value, row) => <AccountCell row={row} /> },
  // 两个标记列头用短名;协作方是多态 fk 列(partyType 判别),由 meta refs 自动解析
  isLeaf: { mobileRole: 'summary' },
  isOutsourced: { label: '外协仓', mobileRole: 'summary' },
  partyType: { label: '协作方类型' },
  partyId: { label: '协作方' },
  allowNegative: { label: '负库存' },
  active: { mobileRole: 'summary' },
}

function WarehousesPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 树的子层缓存在表格组件本地,写后 invalidate 只能刷新根层——一并 remount 清空子层与展开态
  const [reloadKey, setReloadKey] = useState(0)
  const [seeding, setSeeding] = useState(false)
  const queryClient = useQueryClient()
  const binding = useResourceBinding('invWarehouses')
  const support = useWarehouseSupport()
  const document = useResourceDocument('invWarehouses')
  const canSeedDefaults = document.data?.commands.some((command) => command.key === 'seedDefaults') === true

  // 公司列表:默认第一家,并作为选择器回显数据(同科目表页先例)
  const context = useQuery({
    queryKey: ['warehouseContext', support.id, companyId],
    queryFn: () => support.load(companyId),
  })

  useEffect(() => {
    if (companyId == null && (context.data?.companies.length ?? 0) >= 1) {
      const first = context.data!.companies[0]
      setCompanyId(first.id)
    }
  }, [context.data, companyId])

  const companyFilterState = {
    companyId: { kind: 'fk' as const, op: 'in' as const, values: companyId ? [companyId] : [], labels: [] },
  }

  const updateWarehouse = (id: string, input: Record<string, unknown>) => {
    if (!binding.writer || !('update' in binding.writer) || !binding.writer.update) throw new Error('仓库不支持 update')
    return binding.writer.update(id, input)
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">仓库管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        按公司维护仓库树;外协仓必挂一个协作方(供应商/内部公司),其结存即协作方处的我方材料结存。
      </p>

      <div className="mt-6 flex max-w-xl items-end gap-3">
        <div className="min-w-0 flex-1">
        <Select value={companyId} onChange={(value) => {
          const id = value == null || value === '' ? null : String(value)
          setCompanyId(id)
        }}>
          <Label>公司</Label>
          <Select.Trigger><Select.Value>{({ isPlaceholder, defaultChildren }) => isPlaceholder ? '选择公司…' : defaultChildren}</Select.Value><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>{(context.data?.companies ?? []).map((item) => <ListBox.Item key={item.id} id={item.id} textValue={item.name}>{item.code ? `${item.code} - ${item.name}` : item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
        </Select>
        </div>
        {canSeedDefaults && <Button
          variant="secondary"
          isDisabled={!companyId}
          isPending={seeding}
          onPress={async () => {
            if (!companyId || !binding.commands?.commands.seedDefaults) return
            setSeeding(true)
            try {
              const count = await binding.commands.execute('seedDefaults', { companyId })
              toast.success(count > 0 ? '默认仓库已初始化' : '默认仓库已经存在')
              await binding.cache.invalidateAll(queryClient)
              await context.refetch()
              setReloadKey((key) => key + 1)
            } catch (error) {
              toast.danger('初始化默认仓库失败', {
                description: error instanceof Error ? error.message : '请稍后重试',
              })
            } finally {
              setSeeding(false)
            }
          }}
        >
          初始化默认仓库
        </Button>}
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>仓库按公司维护,选择公司后查看其仓库树。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={`${companyId}-${reloadKey}`}
            resource="invWarehouses"
            columns={GRID_COLUMNS}
            tree={{ hasChildrenField: 'hasChildren', sort: { field: 'name', order: 'ASC' } }}
            fixedFilter={companyFilterState}
            joinFields={{ account: ['code'] }}
            overrides={GRID_OVERRIDES}
            onView={(row) => setDrawer({ mode: 'view', row })}
            onCreate={() => setDrawer({ mode: 'create', row: null })}
            onEdit={(row) => setDrawer({ mode: 'edit', row })}
            rowActions={statusToggleActions({
              field: 'active',
              update: updateWarehouse,
              // 树的子层缓存在组件本地,refetch 只刷根层,remount 一并清子层
              onDone: () => setReloadKey((k) => k + 1),
            })}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="invWarehouses"
        label="仓库"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无时间戳),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作;叶子是固有属性留在表单
        exclude={['active', 'companyId']}
        fields={{
          name: { order: 0, required: true, placeholder: '如 原材料仓' },
          parentId: {
            order: 1,
            label: '上级仓库',
            input: ({ value, onChange, isDisabled }) => (
              <Select isDisabled={isDisabled} value={value == null ? null : String(value)} onChange={(next) => onChange(next === '' ? null : next)}>
                <Label>上级仓库</Label><Select.Trigger><Select.Value>{({ isPlaceholder, defaultChildren }) => isPlaceholder ? '请选择…' : defaultChildren}</Select.Value><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox>{(context.data?.parents ?? []).map((item) => <ListBox.Item key={item.id} id={item.id} textValue={item.name}>{item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
              </Select>
            ),
          },
          // 默认叶子;要建归集节点(挂子仓)手动关掉,与物料分类同语义
          isLeaf: { order: 2, cols: 6, defaultValue: true },
          accountId: {
            order: 3,
            cols: 6,
            label: '关联科目',
            input: ({ value, onChange, isDisabled }) => (
              <Select isDisabled={isDisabled} value={value == null ? null : String(value)} onChange={(next) => onChange(next === '' ? null : next)}>
                <Label>关联科目</Label><Select.Trigger><Select.Value>{({ isPlaceholder, defaultChildren }) => isPlaceholder ? '请选择…' : defaultChildren}</Select.Value><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox>{(context.data?.accounts ?? []).map((item) => <ListBox.Item key={item.id} id={item.id} textValue={item.name}>{item.code ? `${item.code} - ${item.name}` : item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
              </Select>
            ),
          },
          // 外协仓开关:关掉时一并清空协作方绑定(后端要求非外协仓协作方为空)
          isOutsourced: {
            order: 4,
            cols: 6,
            label: '外协仓',
            defaultValue: false,
            effects: (v) => (v ? undefined : { partyType: null, partyId: null }),
          },
          // 协作方限供应商/内部公司(后端 WarehouseOutsourced 校验);仅外协仓出现
          partyType: {
            order: 5,
            cols: 6,
            required: true,
            label: '协作方类型',
            visible: (values) => Boolean(values.isOutsourced),
            // 切换协作方类型时清掉已选协作方,避免供应商 id 挂在公司数据源下(同销售订单先例)
            effects: () => ({ partyId: null }),
            input: ({ value, onChange, isDisabled }) => (
              <Select
                isDisabled={isDisabled}
                isRequired
                value={value == null || value === '' ? null : String(value)}
                onChange={(v) => onChange(v === '' ? null : v)}
              >
                <Label>协作方类型</Label>
                <Select.Trigger>
                  <Select.Value>
                    {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                      供应商
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                      内部公司
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            ),
          },
          partyId: {
            order: 6,
            cols: 6,
            required: true,
            label: '协作方',
            // 未选协作方类型时不出现;选定后数据源跟随类型(多态 fk,同销售订单先例)
            visible: (values) =>
              Boolean(values.isOutsourced) && (values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY'),
            input: ({ value, onChange, isDisabled, values }) => {
              const isCompany = values.partyType === 'COMPANY'
              return (
                <Select isDisabled={isDisabled} value={value == null ? null : String(value)} onChange={(next) => onChange(next === '' ? null : next)}>
                  <Label>协作方</Label><Select.Trigger><Select.Value>{({ isPlaceholder, defaultChildren }) => isPlaceholder ? (isCompany ? '选择内部公司…' : '选择供应商…') : defaultChildren}</Select.Value><Select.Indicator /></Select.Trigger>
                  <Select.Popover><ListBox>{(isCompany ? (context.data?.companies ?? []).filter((item) => item.id !== companyId) : (context.data?.suppliers ?? [])).map((item) => <ListBox.Item key={item.id} id={item.id} textValue={item.name}>{item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
                </Select>
              )
            },
          },
          allowNegative: { order: 7, cols: 6, label: '允许负库存', defaultValue: false },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            if (!binding.writer || !('create' in binding.writer) || !binding.writer.create) throw new Error('仓库不支持 create')
            await binding.writer.create({ ...values, companyId })
          } else {
            await updateWarehouse(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '仓库已创建' : '仓库已更新')
          // 抽屉走 rowId 自查,编辑后一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          await binding.cache.invalidateAll(queryClient)
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
