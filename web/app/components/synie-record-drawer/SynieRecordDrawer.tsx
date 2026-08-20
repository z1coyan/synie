import { hasCapability } from '@synie/shared'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { parseDate, parseDateTime } from '@internationalized/date'
import {
  Button,
  Calendar,
  Checkbox,
  DateField,
  DatePicker,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Switch,
  Tabs,
  TextField,
  toast,
} from '@heroui/react'
import { EmptyState, Sheet } from '@heroui-pro/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultCompanyId, useAuthorizedCompanies } from '~/lib/form-defaults'
import { isNotFound } from '~/lib/errors'
import { executeSingleRowCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { resourceBindingFor } from '~/lib/resources/registry'
import { QueryState } from '../synie-query-state/QueryState'
import { cellText } from '../synie-data-grid/format'
import { useGridMeta } from '../synie-data-grid/meta'
import { UUID_RE } from '../synie-data-grid/query'
import type { GridColumnMeta, LocalGridMeta, Row } from '../synie-data-grid/types'
import { RemoteDialogSelect } from '../synie-remote-select/RemoteDialogSelect'
import { RemoteSelect } from '../synie-remote-select/RemoteSelect'
import type { RemoteSourceConfig } from '../synie-remote-select/remote-query'
import { FkLink } from './fk-preview'
import {
  collectValues,
  fieldChangePatch,
  initialValues,
  isFieldDisabled,
  missingRequiredFields,
  renderableFields,
  resolveFields,
  type DrawerMode,
  type FieldOverride,
  type ResolvedField,
} from './fields'

/** headerContent/extraContent/tabExtraContent 共用签名:入参是冻结后的 mode/row
 * (与渲染同一套快照,退场动画期间不闪);values 为当前表单草稿(view 态为空对象),
 * patchValues 向草稿并入补丁(view 态 no-op) */
export type DrawerExtraContent = (
  mode: DrawerMode,
  row: Row | null | undefined,
  values: Record<string, unknown>,
  patchValues: (patch: Record<string, unknown>) => void,
) => ReactNode

export interface DrawerTab {
  key: string
  label: string
}

export interface SynieRecordDrawerProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  mode: DrawerMode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 资源中文名,标题拼为 新增{label}/编辑{label}/{label}详情 */
  label?: string
  /** view/edit 数据源:直接用表格行数据,不按 id 重查 */
  row?: Row | null
  /** 没有现成行数据时(fk 速览等)按 id 自查一行;row 优先 */
  rowId?: string
  exclude?: string[]
  fields?: Record<string, FieldOverride>
  /** 本地列/字段定义,提供时跳过 GridMeta 查询(resource 仅作缓存 key/标题用途) */
  meta?: LocalGridMeta
  /**
   * create/edit 提交;resolve 即成功(组件关抽屉),throw 则 toast 且不关。
   * 返回保存后的记录 id(create 态必须返回):meta 下发 audit 扩展动作且用户有 audit 能力时,
   * 保存按钮旁自动出现「保存并审核」,取该 id 调审核 mutation(通用约定,见 web/AGENTS.md)。
   */
  onSubmit?: (values: Record<string, unknown>, mode: 'create' | 'edit') => Promise<string | void>
  /** view 态 footer 显示「编辑」按钮,点击回调(页面自行切 mode) */
  onEdit?: () => void
  /** create/edit 态提交按钮文案,默认「保存」(如导入表单的「解析」) */
  submitLabel?: string
  /** 外部聚合/附件等提交前置数据尚未就绪时，禁用所有保存入口。 */
  isSubmitDisabled?: boolean
  /** 服务端提交失败后的字段错误；key 与表单字段名一致，抽屉在字段下方就近展示。 */
  fieldErrors?: Record<string, string[]>
  /** 提交错误位于非当前 tab 时，由页面指定应切换到的 tab。 */
  submissionErrorTab?: string | null
  /** 保存成功但后续审核失败时保留抽屉，让用户就地修正后重试。 */
  keepOpenOnAuditFailure?: boolean
  /** view 态 footer 附加动作(渲染在「关闭」之后),如导入记录的「导入」主按钮 */
  footerActions?: (mode: DrawerMode, row: Row | null | undefined) => ReactNode
  /** Sheet.Content 宽度样式 */
  contentClassName?: string
  /**
   * 字段栅格之前的头部内容(如金额主视觉/概要卡、承兑票面区),占满整行;
   * 声明 tabs 时恒显示在 tab 栏之上,不随 tab 切换
   */
  headerContent?: DrawerExtraContent
  /**
   * meta 列之外的附加内容(如多对多关联控件),渲染在字段栅格末尾、占满整行;
   * 状态由页面自持,提交在页面 onSubmit 里自行处理。
   * 声明 tabs 时本槽归入首个 tab,其余 tab 的附加内容走 tabExtraContent。
   */
  extraContent?: DrawerExtraContent
  /**
   * tabs 分区声明(首个为主 tab);不声明则不渲染 tab 栏,布局与单页形态完全一致。
   * 字段经 FieldOverride.tab 路由(缺省归首 tab);必填缺失保存时自动切到缺失字段所在 tab。
   */
  tabs?: DrawerTab[]
  /** 非首 tab 的附加内容槽,key 为 tab key(首 tab 的附加内容仍走 extraContent) */
  tabExtraContent?: Record<string, DrawerExtraContent>
}

// Tailwind v4 JIT 扫不到动态拼接类名,1-12 静态映射
const COL_SPAN: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  9: 'lg:col-span-9',
  10: 'lg:col-span-10',
  11: 'lg:col-span-11',
  12: 'lg:col-span-12',
}

// 非法日期串回落 null,不让整个抽屉崩掉
const safeParseDate = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

// datetime 草稿是本地 YYYY-MM-DDTHH:mm:ss(fields.ts toLocalDateTime 产出)
const safeParseDateTime = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  try {
    return parseDateTime(v)
  } catch {
    return null
  }
}

// 稳定空数组回退:remoteMeta.data?.columns 未就绪时若每次渲染都 `?? []` 新建数组,
// 会让下方以 columns 为依赖的 effect 每次渲染都判定"变了",存在自激重渲染风险
const EMPTY_COLUMNS: GridColumnMeta[] = []
const DISABLED_LOCAL_ROW_QUERY_KEY = ['disabledLocalRecord'] as const

export function SynieRecordDrawer(props: SynieRecordDrawerProps) {
  const { resource, mode, isOpen, exclude, label = '', contentClassName = 'w-full lg:w-[480px]' } = props
  // 本地 Meta 可以使用未注册的展示资源，因此只在远程 Meta 模式解析 binding。
  const binding = !props.meta ? resourceBindingFor(resource) : undefined
  const remoteMeta = useGridMeta(resource, !props.meta) // 本地模式不发请求
  const columns = props.meta?.columns ?? remoteMeta.data?.columns ?? EMPTY_COLUMNS
  const metaPending = !props.meta && remoteMeta.isPending
  const metaError = !props.meta && remoteMeta.isError

  // rowId 自取数:row 未给时按 id 查一行(列集取自 meta)。
  // id 非法(白名单反查约定,防拼进查询)按查无处理,不发请求。
  // 本地 meta 模式下该自查路径不适用(无远程 meta 可拼列/查询),wantsFetch 直接置 false:
  // disabled query 永远 isPending,若只挡 enabled 不挡 wantsFetch,rowPending 会恒 true 卡死 spinner。
  const wantsFetch = !props.meta && !props.row && !!props.rowId
  const validId = !!props.rowId && UUID_RE.test(props.rowId)
  const byId = useQuery({
    queryKey:
      binding?.cache.rowKey(props.rowId) ?? DISABLED_LOCAL_ROW_QUERY_KEY,
    enabled: isOpen && wantsFetch && validId && !!remoteMeta.data,
    queryFn: () => binding!.reader.get(props.rowId!),
  })
  const row = props.row ?? byId.data ?? null
  // isPending 含 enabled 未就绪(等 meta)阶段;data === null 是「查过了但没有」(未查完是 undefined)
  const rowPending = wantsFetch && validId && byId.isPending
  // not_found(含行级范围不命中的新语义)按「查无此行」呈现,不落泛化加载失败文案
  const rowMissing =
    wantsFetch && (!validId || byId.data === null || isNotFound(byId.error))

  // 关闭动画期间冻结最后一次打开时的内容:onOpenChange(false) 后父级常把 mode 回落
  // 'view'、row 置 undefined,若渲染路径跟着实时切换,会在 Sheet 退出动画播放期间把
  // 详情/表单闪变成空态。isOpen 为 true 时把 { mode, row } 存入 ref;isOpen 为 false 时
  // 渲染改读 ref 里的快照(从未打开过则退回当前 props)。
  // values 重建 effect 与 save() 继续用实际 props——它们只在 isOpen 为 true 时工作,不受影响。
  const lastOpenRef = useRef<{ mode: DrawerMode; row?: Row | null } | null>(null)
  if (isOpen) {
    lastOpenRef.current = { mode, row }
  }
  const frozen = isOpen ? null : lastOpenRef.current
  const renderMode = frozen ? frozen.mode : mode
  const renderRow = frozen ? frozen.row : row

  const fields = resolveFields(columns, renderMode, exclude, props.fields)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  /** 上次提交的服务端字段错误（ApiError.fields）；与 props.fieldErrors 合并展示 */
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string[]>>({})
  const fieldErrorsOf = (name: string): string[] => [
    ...(props.fieldErrors?.[name] ?? []),
    ...(serverFieldErrors[name] ?? []),
  ]
  const queryClient = useQueryClient()

  // 新建态公司默认:授权列表第一家(字段 defaultValue / 列筛优先;异步到达后补丁)
  const hasCompanyField = fields.some((f) => f.name === 'companyId')
  const companiesQuery = useAuthorizedCompanies(isOpen && mode === 'create' && hasCompanyField)
  const autoCompanyId = defaultCompanyId(undefined, companiesQuery.data ?? [])

  // 「保存并审核」通用约定:资源 meta 下发 key=audit 的行级扩展动作、且当前用户 capabilities
  // 含 audit 时,保存按钮旁多出该按钮。行带 status 字段且非草稿时不给入口(服务端权威校验兜底)。
  const auditAction = remoteMeta.data?.extendedActions?.find(
    (a) => a.key === 'audit' && (a.scope === 'row' || a.scope === 'both'),
  )
  const canSaveAndAudit =
    !!props.onSubmit &&
    !!auditAction &&
    hasCapability(remoteMeta.data?.capabilities ?? [], auditAction.requiredCapability) &&
    (renderRow?.status == null || renderRow?.status === 'DRAFT')
  // 当前 tab:null 表示未手动切换过(回落首 tab),每次打开抽屉重置
  const [activeTab, setActiveTab] = useState<string | null>(null)

  // 打开/换行/换模式时重建草稿(view 不用草稿,直接读 row)。
  // props.fields/exclude 常为内联字面量,进依赖会在父级每次渲染时重置用户输入;
  // 初值只取决于列类型与行数据,故不列入。
  useEffect(() => {
    if (isOpen && mode !== 'view') {
      setValues(initialValues(resolveFields(columns, mode, exclude, props.fields), row))
    }
    // 换行/换模式/重开抽屉即丢弃上次提交的服务端字段错误
    setServerFieldErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, row, columns])

  // 公司列表异步到达后回填(不覆盖用户已选 / 字段 defaultValue 已写入的值)
  useEffect(() => {
    if (!isOpen || mode !== 'create' || autoCompanyId == null || !hasCompanyField) return
    setValues((v) => {
      if (v.companyId != null && v.companyId !== '') return v
      return { ...v, companyId: autoCompanyId }
    })
  }, [isOpen, mode, autoCompanyId, hasCompanyField])

  // 每次打开抽屉回到首 tab(isOpen 翻转才触发,mode/row 切换不清用户所在 tab)
  useEffect(() => {
    if (isOpen) setActiveTab(null)
  }, [isOpen])

  useEffect(() => {
    if (isOpen && props.submissionErrorTab) {
      setActiveTab(props.submissionErrorTab)
    }
  }, [isOpen, props.submissionErrorTab])

  // 主栅格只渲染非 hidden 字段;hidden 字段仍在 fields 里参与必填/提交(由 extraContent 写值)
  const shown = renderableFields(
    fields,
    renderMode === 'view' ? ((renderRow ?? {}) as Record<string, unknown>) : values,
  )

  const tabs = props.tabs ?? []
  const firstTabKey = tabs[0]?.key ?? null
  // 空 tab 隐藏:无任何可见字段且无附加内容槽的 tab 不渲染(如 fk 速览没有页面的 tabExtraContent,
  // 单位转换 tab 会是空的);只剩一个可见 tab 时整栏不渲染,退回单页形态
  const visibleTabs = tabs.filter(
    (t) =>
      shown.some((f) => (f.tab ?? firstTabKey) === t.key) ||
      (t.key === firstTabKey ? !!props.extraContent : !!props.tabExtraContent?.[t.key])
  )
  const tabsOn = visibleTabs.length > 1
  const wantedTab = activeTab ?? firstTabKey
  const currentTab = visibleTabs.some((t) => t.key === wantedTab) ? wantedTab : (visibleTabs[0]?.key ?? firstTabKey)

  const title = renderMode === 'create' ? `新增${label}` : renderMode === 'edit' ? `编辑${label}` : `${label}详情`

  // extraContent 第 4 参:把补丁并入表单草稿;view 态无草稿可改,no-op
  const patchValues = (patch: Record<string, unknown>) => {
    if (renderMode === 'view') return
    setValues((v) => ({ ...v, ...patch }))
  }

  const save = async (andAudit = false) => {
    if (!props.onSubmit || mode === 'view' || props.isSubmitDisabled) return
    const missing = missingRequiredFields(fields, values, mode)
    if (missing.length > 0) {
      // 缺失字段在非当前 tab 时先切过去,toast 指名字段,用户不用猜去哪儿补
      if (tabsOn) setActiveTab(missing[0].tab ?? firstTabKey)
      toast.danger(`请填写:${missing.map((f) => f.label).join('、')}`)
      return
    }
    setSaving(true)
    try {
      const savedId = await props.onSubmit(collectValues(fields, values, mode), mode)
      let closeAfterSave = true
      if (andAudit && auditAction) {
        // create 态靠 onSubmit 返回的新 id;edit 态回落行 id
        const auditId = savedId ?? row?.id
        if (auditId == null || auditId === '') {
          toast.warning('单据已保存,但未取得单据 id,请在列表中执行审核')
          closeAfterSave = !props.keepOpenOnAuditFailure
        } else {
          let errors: { message: string }[] | null | undefined
          try {
            await executeSingleRowCommandWithInvalidation(
              resource,
              auditAction.key,
              String(auditId),
              queryClient,
            )
          } catch (error) {
            errors = [{ message: error instanceof Error ? error.message : String(error) }]
          }
          if (errors?.length) {
            // 单据已落库(草稿),审核未过:如实告知,不关抽屉外的任何状态
            toast.danger('单据已保存,但审核失败', {
              description: errors.map((e) => e.message).join('; '),
            })
            closeAfterSave = !props.keepOpenOnAuditFailure
          } else {
            toast.success('已保存并审核')
          }
        }
      }
      setServerFieldErrors({})
      if (closeAfterSave) props.onOpenChange(false)
    } catch (e) {
      // 服务端字段级校验（ApiError.fields）就近展示在字段下方，并把文案带进 toast——
      // 否则用户只看到 envelope 顶层的「XX 参数不合法」，真正的原因被丢掉
      const fields = serverFieldErrorsOf(e)
      setServerFieldErrors(fields ?? {})
      const detail = fields ? Object.values(fields).flat().join('；') : (e as Error).message
      toast.danger('保存失败', { description: detail })
    } finally {
      setSaving(false)
    }
  }

  // 字段栅格(含 section 分组标题);subset 已按 tab 过滤好
  const renderFields = (subset: ResolvedField[]) => (
    <>
      {(() => {
        // 分组标题:section 非空且变化时在该字段前插标题行;'' 显式收编
        // (画 hairline,之后字段在组外);undefined 并入上一组。
        // 标题行只随「首个携带新 section 的可见字段」出现,组内无可见字段则不渲染
        let lastSection: string | undefined
        return subset.map((f) => {
          let header: ReactNode = null
          if (f.section === '') {
            if (lastSection !== undefined) header = <div className="border-t border-separator" />
            lastSection = undefined
          } else if (f.section != null) {
            if (f.section !== lastSection) {
              header = <h3 className="border-b border-separator pb-2 text-sm font-medium">{f.section}</h3>
            }
            lastSection = f.section
          }
          return (
            <Fragment key={f.name}>
              {/* 字段前插槽(FieldOverride.before);返回 null/undefined 不渲染占位容器(同 headerContent 惯例) */}
              {(() => {
                const node = f.before?.(renderMode, renderRow, values, patchValues)
                return node == null ? null : <div className="lg:col-span-12">{node}</div>
              })()}
              {header && <div className="lg:col-span-12">{header}</div>}
              <div className={COL_SPAN[f.cols]}>
                {renderMode === 'view' ? (
                  <ViewField field={f} row={renderRow ?? ({ id: '' } as Row)} />
                ) : (
                  <FieldInput
                    field={f}
                    row={renderRow}
                    value={values[f.name]}
                    values={values}
                    isDisabled={isFieldDisabled(f, renderMode) || saving}
                    onChange={(v, selectedRow) =>
                      setValues((prev) => ({
                        ...prev,
                        ...fieldChangePatch(f, v, selectedRow),
                      }))
                    }
                    patchValues={patchValues}
                  />
                )}
                {renderMode !== 'view' && fieldErrorsOf(f.name).length > 0 ? (
                  <p className="mt-1 text-xs text-danger" role="alert">
                    {fieldErrorsOf(f.name).join('；')}
                  </p>
                ) : null}
              </div>
            </Fragment>
          )
        })
      })()}
    </>
  )

  // 一个 tab 的内容:字段栅格 + 该 tab 的附加内容槽(首 tab 走 extraContent,其余走 tabExtraContent);
  // tabKey 为 null 即单页形态(未声明 tabs),渲染全部字段
  const renderTabBody = (tabKey: string | null) => {
    const subset = tabKey == null ? shown : shown.filter((f) => (f.tab ?? firstTabKey) === tabKey)
    const extraFn = tabKey == null || tabKey === firstTabKey ? props.extraContent : props.tabExtraContent?.[tabKey]
    return (
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-12">
        {renderFields(subset)}
        {extraFn && <div className="mt-2 lg:col-span-12">{extraFn(renderMode, renderRow, values, patchValues)}</div>}
      </div>
    )
  }

  // isHandleOnly:侧向 Sheet 正文拖关会与文本选择/表单交互冲突(HeroUI 对 left/right
  // 不做选区守卫)。本抽屉不放把手,关闭走 X/按钮/遮罩;移动端底部 Sheet 见 filter-sheet。
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={props.onOpenChange}
      placement="right"
      isHandleOnly
    >
      <Sheet.Backdrop>
        <Sheet.Content className={contentClassName}>
          {/* 显式 aria-label:Heading slot 的 labelledby 在过渡期渲染中晚一拍,RAC 会刷
              "Dialog 必须有标题" 的误报警告;有 aria-label 则完全绕开该告警路径 */}
          <Sheet.Dialog className="h-full" aria-label={title}>
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {metaError || (byId.isError && !isNotFound(byId.error)) ? (
                // GridMeta/rowId 取数失败:展示报错并可重试(与 SynieDataGrid 同一套失败态)。
                // 错误分支在 spinner 之前:meta 失败时 byId 因 enabled 门控永远 isPending,反序会卡死转圈。
                // 403 由 QueryState 渲染「无权限访问」专属态(与 grid 对齐;此前混在通用失败态里)
                <QueryState
                  error={(remoteMeta.error ?? byId.error) as Error}
                  onRetry={() => (metaError ? remoteMeta.refetch() : byId.refetch())}
                />
              ) : metaPending || rowPending ? (
                <QueryState isPending />
              ) : rowMissing ? (
                <EmptyState size="md" className="h-64 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>记录不存在或无权查看</EmptyState.Title>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <>
                {/* 返回 null/undefined 不渲染占位容器(空 div 的 mb-3 会平白多出一段间距) */}
                {(() => {
                  const node = props.headerContent?.(renderMode, renderRow, values, patchValues)
                  return node == null ? null : <div className="mb-3">{node}</div>
                })()}
                {tabsOn ? (
                  <Tabs
                    variant="secondary"
                    selectedKey={currentTab}
                    onSelectionChange={(key) => setActiveTab(String(key))}
                  >
                    <Tabs.ListContainer>
                      {/* 同销售订单 tabs 先例:收紧为内容宽靠左,容器全宽底边保留 */}
                      <Tabs.List aria-label={`${label}表单分区`} className="w-fit min-w-0 *:w-auto">
                        {visibleTabs.map((t) => (
                          <Tabs.Tab key={t.key} id={t.key}>
                            {t.label}
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel id={currentTab!} className="pt-2">
                      {renderTabBody(currentTab)}
                    </Tabs.Panel>
                  </Tabs>
                ) : (
                  // 声明了 tabs 但只有一个可见 tab:仍按 tab 过滤字段与内容槽(首 tab 可能恰恰是空槽)
                  renderTabBody(tabs.length > 0 ? currentTab : null)
                )}
                </>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              {mode === 'view' ? (
                <>
                  <Sheet.Close>
                    <Button size="sm" variant="secondary">关闭</Button>
                  </Sheet.Close>
                  {props.footerActions?.(renderMode, renderRow)}
                  {props.onEdit && <Button size="sm" onPress={props.onEdit}>编辑</Button>}
                </>
              ) : (
                <>
                  <Sheet.Close>
                    <Button size="sm" variant="secondary" isDisabled={saving}>
                      取消
                    </Button>
                  </Sheet.Close>
                  {/* 元数据失败时字段集为空,禁止提交空 payload */}
                  {canSaveAndAudit && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => void save(true)}
                      isPending={saving}
                      isDisabled={metaError || props.isSubmitDisabled}
                    >
                      保存并审核
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onPress={() => void save()}
                    isPending={saving}
                    isDisabled={metaError || props.isSubmitDisabled}
                  >
                    {props.submitLabel ?? '保存'}
                  </Button>
                </>
              )}
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}

/** view 态字段:label + 与表格同一套格式化(cellText) */
/**
 * 从提交异常里取服务端字段级错误（`ApiError.fields` wire 形状：字段名 → 文案数组）。
 * 结构判定而非 instanceof：抽屉不依赖 HTTP 客户端，测试用的假错误同样适用。
 */
function serverFieldErrorsOf(error: unknown): Record<string, string[]> | null {
  if (typeof error !== 'object' || error === null || !('fields' in error)) return null
  const fields = (error as { fields?: unknown }).fields
  if (typeof fields !== 'object' || fields === null) return null
  const out: Record<string, string[]> = {}
  for (const [name, messages] of Object.entries(fields as Record<string, unknown>)) {
    if (Array.isArray(messages) && messages.length > 0) {
      out[name] = messages.map((m) => String(m))
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function ViewField({ field, row }: { field: ResolvedField; row: Row }) {
  if (field.col.type === 'fk' && field.col.ref && !field.render) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{field.label}</span>
        <div className="text-sm">
          <FkLink col={field.col} row={row} />
        </div>
      </div>
    )
  }
  const value = row[field.name]
  const text = cellText(field.col, value, row)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{field.label}</span>
      <div className="text-sm">
        {field.render ? field.render(value, row) : text || <span className="text-muted">—</span>}
      </div>
    </div>
  )
}

/** 表单控件按列类型分发(filter-popover 先例);override.input 优先 */
function FieldInput({
  field,
  row,
  value,
  values,
  isDisabled,
  onChange,
  patchValues,
}: {
  field: ResolvedField
  row?: Row | null
  value: unknown
  values: Record<string, unknown>
  isDisabled: boolean
  onChange: (v: unknown, selectedRow?: Row | null) => void
  patchValues: (patch: Record<string, unknown>) => void
}) {
  if (field.input) return <>{field.input({ value, onChange, isDisabled, values, patchValues })}</>

  // fk 列:ref(权限裁剪后)或页面 remote.resource 提供数据源;都没有(含多态 fk,表单需页面
  // 按判别字段自定义 input,journals 先例)则落到 default TextField(fail-closed)
  if (field.col.type === 'fk') {
    const ref = field.col.ref
    const cfg = { resource: ref?.resource ?? undefined, labelField: ref?.labelField ?? undefined, ...field.remote }
    if (cfg.resource) {
      const rel = ref?.relation && row ? ((row[ref.relation] as Row | null | undefined) ?? null) : null
      const common = {
        ...(cfg as RemoteSourceConfig & { resource: string }),
        label: field.label,
        value: value == null || value === '' ? null : String(value),
        onChange: (id: string | null, selectedRow: Row | null) =>
          onChange(id, selectedRow),
        isDisabled,
        isRequired: field.required,
        placeholder: field.placeholder,
        initialRows: rel ? [rel] : undefined,
      }
      return field.picker === 'dialog'
        ? <RemoteDialogSelect {...common} {...field.dialog} />
        : <RemoteSelect {...common} />
    }
  }

  switch (field.col.type) {
    case 'boolean':
      // 与带 Label 的输入框并排时开关偏矮,撑满格高垂直居中对齐
      return (
        <div className="flex h-full items-center">
          <Switch isSelected={Boolean(value)} onChange={onChange} isDisabled={isDisabled}>
            <Switch.Content className="text-sm">
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              {field.label}
            </Switch.Content>
          </Switch>
        </div>
      )
    case 'integer':
    case 'decimal':
      return (
        <NumberField
          fullWidth
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>{field.label}</Label>
          {/* 库样式 group 是 grid-cols-[40px_1fr_40px](给步进按钮留列);不渲染步进
              按钮时 input 会掉进 40px 列,改单列让 input 撑满 */}
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder={field.placeholder} />
          </NumberField.Group>
        </NumberField>
      )
    case 'date':
    case 'datetime':
      // datetime 到秒粒度(银行流水交易时间先例),CalendarDateTime.toString() 落草稿
      // YYYY-MM-DDTHH:mm:ss;date 保持日粒度 YYYY-MM-DD
      return (
        <DatePicker
          granularity={field.col.type === 'datetime' ? 'second' : 'day'}
          hourCycle={24}
          isDisabled={isDisabled}
          isRequired={field.required}
          value={field.col.type === 'datetime' ? safeParseDateTime(value) : safeParseDate(value)}
          onChange={(v) => onChange(v ? v.toString() : null)}
        >
          <Label>{field.label}</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label={field.label}>
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
              <Calendar.YearPickerGrid>
                <Calendar.YearPickerGridBody>
                  {({ year }) => <Calendar.YearPickerCell year={year} />}
                </Calendar.YearPickerGridBody>
              </Calendar.YearPickerGrid>
            </Calendar>
          </DatePicker.Popover>
        </DatePicker>
      )
    case 'enum':
      return (
        <Select
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null || value === '' ? null : String(value)}
          onChange={(v) => onChange(v === '' ? null : v)}
        >
          <Label>{field.label}</Label>
          <Select.Trigger>
            {/* RAC Select 无 placeholder prop,占位文案走 Value 的 render prop */}
            <Select.Value>
              {({ isPlaceholder, defaultChildren }) =>
                isPlaceholder ? (field.placeholder ?? '请选择…') : defaultChildren
              }
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {/* 可选枚举给「(无)」清空项(空串 key 提交映射回 null),必填枚举不给 */}
              {!field.required && (
                <ListBox.Item key="" id="" textValue="(无)">
                  <span className="text-muted">(无)</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
              {(field.col.enumOptions ?? []).map((o) => (
                <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )
    case 'enumArray': {
      // 枚举数组多选:Checkbox 两列勾选组(项目无 CheckboxGroup 先例,复用列筛选的 Checkbox 写法);
      // 提交顺序按 enumOptions 声明序归一,与后端枚举定义序一致
      const selected = Array.isArray(value) ? (value as string[]) : []
      const canonical = (next: string[]) =>
        (field.col.enumOptions ?? []).map((o) => o.value).filter((v) => next.includes(v))
      return (
        <div className="flex flex-col gap-1.5">
          <Label>{field.label}</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {(field.col.enumOptions ?? []).map((o) => (
              <Checkbox
                key={o.value}
                slot={null}
                isDisabled={isDisabled}
                isSelected={selected.includes(o.value)}
                onChange={(sel) =>
                  onChange(canonical(sel ? [...selected, o.value] : selected.filter((v) => v !== o.value)))
                }
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {o.label}
                </Checkbox.Content>
              </Checkbox>
            ))}
          </div>
        </div>
      )
    }
    default:
      return (
        <TextField
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null ? '' : String(value)}
          onChange={onChange}
        >
          <Label>{field.label}</Label>
          <Input placeholder={field.placeholder} />
        </TextField>
      )
  }
}
