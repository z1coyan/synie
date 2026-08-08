import { useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  Checkbox,
  Modal,
  NumberField,
  Spinner,
  Table,
} from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import type { Row } from '../synie-data-grid/types'

/**
 * 「批量源行挑选」通用组件:子条目表工具栏按钮 → 弹窗勾选源单行 → 弹窗内逐行填数量 →
 * 确认生成多行子表草稿行。适用"子表行来自上游单据行"的场景(订单←报价、发货←订单、
 * 入库←订单、需求单←订单等),替代逐行单选录入。
 *
 * 设计约定(2026-08 评审结论):
 * - 弹窗只承担「勾选 + 数量」;税率/仓位/损耗率等其余字段靠调用方在 buildRows 里给默认值,
 *   例外行落子表后用行表单补;
 * - 取数/过滤/池剔除由调用方负责(各场景候选池口径差异大:剩余量、占用、有效期……),
 *   本组件只管交互与数量校验;
 * - 重复防呆用「池剔除」:调用方把已在单上的源行 id 从 pool 里滤掉,组件不查重;
 * - 超量(maxQty)前端即时拦截:输入框红字 + 禁止确认;后端校验保留兜底。
 */

export interface SourcePickerColumn {
  key: string
  label: ReactNode
  align?: 'start' | 'end'
  className?: string
  /** 缺省渲染 String(row[key] ?? '—') */
  render?: (row: Row) => ReactNode
}

export interface PickedSourceLine {
  source: Row
  qty: number
}

export interface SourceLinesPickerProps {
  /** 工具栏按钮与弹窗标题(如「从报价批量选择」) */
  buttonLabel: string
  /** 确认按钮文案,缺省「纳入」 */
  confirmLabel?: string
  /** 入口禁用(如单头要素未选齐);禁用原因经调用方工具栏提示文案表达 */
  isDisabled?: boolean
  /** 候选池:调用方已完成取数、业务过滤与池剔除(排除已在单上的源行) */
  pool: Row[]
  isPending?: boolean
  /** 取数失败态(fail-closed:如实展示,不降级绕过);配 onRetry 给重试入口 */
  error?: Error | null
  onRetry?: () => void
  emptyTitle?: string
  emptyDescription?: string
  /** 展示列(数量输入列由组件追加在末尾) */
  columns: SourcePickerColumn[]
  /** 勾选时数量初始值(如剩余可发量);返回 null/缺省 = 空,用户必填 */
  suggestQty?: (row: Row) => number | null
  /** 该行数量上限(如剩余可发量);提供则超量前端拦截 */
  maxQty?: (row: Row) => number | null
  qtyLabel?: string
  /** 勾选项 → 子表草稿行(带 local: 前缀 id,由调用方生成并给默认值) */
  buildRows: (picked: PickedSourceLine[]) => Row[]
  onConfirm: (rows: Row[]) => void
  /** 受控开关:调用方需要按 open 启停候选池查询时使用;非受控则内部自持 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** 数量合法性:必填、> 0、不超上限;返回错误文案或 null */
function qtyError(qty: number | null, max: number | null): string | null {
  if (qty == null || !Number.isFinite(qty)) return '必填'
  if (qty <= 0) return '需大于零'
  if (max != null && qty > max) return `超上限 ${max}`
  return null
}

export function SourceLinesPicker(props: SourceLinesPickerProps) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = props.open ?? innerOpen
  const setOpen = (v: boolean) => {
    setInnerOpen(v)
    props.onOpenChange?.(v)
  }
  // 勾选态:源行 id → 数量(null = 未填);勾选时按 suggestQty 给初始值
  const [picked, setPicked] = useState<Map<string, number | null>>(new Map())

  const poolIds = useMemo(() => new Set(props.pool.map((r) => r.id)), [props.pool])
  // 池刷新后剔除已不在池里的勾选(如池剔除口径随单头变化)
  const effectivePicked = useMemo(
    () => new Map([...picked].filter(([id]) => poolIds.has(id))),
    [picked, poolIds],
  )

  const toggle = (row: Row, on: boolean) =>
    setPicked((prev) => {
      const next = new Map(prev)
      if (on) next.set(row.id, props.suggestQty?.(row) ?? null)
      else next.delete(row.id)
      return next
    })

  const setQty = (id: string, qty: number | null) =>
    setPicked((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.set(id, qty)
      return next
    })

  const errors = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of props.pool) {
      if (!effectivePicked.has(r.id)) continue
      const msg = qtyError(
        effectivePicked.get(r.id) ?? null,
        props.maxQty?.(r) ?? null,
      )
      if (msg) map.set(r.id, msg)
    }
    return map
  }, [props.pool, props.maxQty, effectivePicked])

  const confirm = () => {
    const lines = props.pool
      .filter((r) => effectivePicked.has(r.id))
      .map((r) => ({ source: r, qty: effectivePicked.get(r.id)! }))
    props.onConfirm(props.buildRows(lines))
    setPicked(new Map())
    setOpen(false)
  }

  const loading = props.isPending === true
  const title = props.buttonLabel
  const qtyHeader = props.qtyLabel ?? '数量'

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        isDisabled={props.isDisabled}
        onPress={() => {
          setPicked(new Map())
          setOpen(true)
        }}
      >
        {props.buttonLabel}
      </Button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-4xl" aria-label={title}>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {loading ? (
                <div className="flex h-48 items-center justify-center">
                  <Spinner />
                </div>
              ) : props.error ? (
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>候选条目加载失败</EmptyState.Title>
                    <EmptyState.Description>
                      {props.error.message}
                    </EmptyState.Description>
                  </EmptyState.Header>
                  {props.onRetry && (
                    <EmptyState.Content>
                      <Button size="sm" variant="secondary" onPress={props.onRetry}>
                        重试
                      </Button>
                    </EmptyState.Content>
                  )}
                </EmptyState>
              ) : props.pool.length === 0 ? (
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>
                      {props.emptyTitle ?? '无可选条目'}
                    </EmptyState.Title>
                    {props.emptyDescription && (
                      <EmptyState.Description>
                        {props.emptyDescription}
                      </EmptyState.Description>
                    )}
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <Table>
                  <Table.ScrollContainer className="max-h-96">
                    <Table.Content aria-label={title}>
                      <Table.Header>
                        <Table.Column className="w-10" />
                        {props.columns.map((c) => (
                          <Table.Column
                            key={c.key}
                            className={[
                              c.align === 'end' ? 'text-end' : '',
                              c.className ?? '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {c.label}
                          </Table.Column>
                        ))}
                        <Table.Column className="w-36 text-end">
                          {qtyHeader}
                        </Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {props.pool.map((r) => {
                          const on = effectivePicked.has(r.id)
                          const err = errors.get(r.id)
                          return (
                            <Table.Row key={r.id}>
                              <Table.Cell>
                                <Checkbox
                                  slot={null}
                                  aria-label={`选择 ${String(r.id).slice(0, 8)}`}
                                  isSelected={on}
                                  onChange={(v) => toggle(r, v)}
                                >
                                  <Checkbox.Content>
                                    <Checkbox.Control>
                                      <Checkbox.Indicator />
                                    </Checkbox.Control>
                                  </Checkbox.Content>
                                </Checkbox>
                              </Table.Cell>
                              {props.columns.map((c) => (
                                <Table.Cell
                                  key={c.key}
                                  className={[
                                    c.align === 'end' ? 'text-end' : '',
                                    c.className ?? '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                >
                                  {c.render
                                    ? c.render(r)
                                    : String(r[c.key] ?? '—')}
                                </Table.Cell>
                              ))}
                              <Table.Cell className="text-end">
                                {on ? (
                                  <div className="flex flex-col items-end gap-0.5">
                                    <NumberField
                                      aria-label={`${qtyHeader} ${String(r.id).slice(0, 8)}`}
                                      value={effectivePicked.get(r.id) ?? NaN}
                                      minValue={0}
                                      isInvalid={err != null}
                                      onChange={(v) =>
                                        setQty(
                                          r.id,
                                          Number.isFinite(v) ? v : null,
                                        )
                                      }
                                    >
                                      <NumberField.Group>
                                        <NumberField.Input className="text-end" />
                                      </NumberField.Group>
                                    </NumberField>
                                    {err && (
                                      <span className="text-xs text-danger">
                                        {err}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </Table.Cell>
                            </Table.Row>
                          )
                        })}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
              )}
            </Modal.Body>
            <Modal.Footer>
              <span className="mr-auto text-sm text-muted">
                已选 {effectivePicked.size} 条
                {errors.size > 0 && (
                  <span className="text-danger">
                    （{errors.size} 条数量待修正）
                  </span>
                )}
              </span>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button
                isDisabled={effectivePicked.size === 0 || errors.size > 0}
                onPress={confirm}
              >
                {props.confirmLabel ?? '纳入'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
