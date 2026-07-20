import { useState } from 'react'
import { Button, CloseButton, Label, Modal } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '../synie-data-grid/SynieDataGrid'
import type { Row, SortState } from '../synie-data-grid/types'
import { optionLabel, resolveSource } from './remote-query'
import { useRemoteRecords } from './use-remote'
import type { RemoteSelectProps } from './RemoteSelect'

export interface RemoteDialogSelectProps extends RemoteSelectProps {
  dialogTitle?: string
  /** 弹窗表格的恒定过滤(透传 SynieDataGrid fixedFilter);枚举值用 gqlEnum() 包装 */
  gridFilter?: Record<string, unknown>
  /** 弹窗表格显示列(有序白名单),缺省 meta 全列 */
  gridColumns?: string[]
  /** 弹窗表格列覆盖(标签/渲染等),透传 SynieDataGrid overrides */
  gridOverrides?: Record<string, ColumnOverride>
  /** 弹窗表格初始排序 */
  gridDefaultSort?: SortState
  /** 列外取回字段(确认选中时要带 materialId 等业务键) */
  gridExtraFields?: string[]
  /** 弹窗宽度 class,默认 max-w-4xl */
  dialogClassName?: string
}

export function RemoteDialogSelect(props: RemoteDialogSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  // 弹窗内草稿,确认才提交
  const [draft, setDraft] = useState<Row[]>([])

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value != null && !known.has(props.value) ? [props.value] : [])
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const selectedRow = props.value != null ? (known.get(props.value) ?? null) : null
  const display = selectedRow
    ? (props.renderValue?.(selectedRow) ?? optionLabel(src, selectedRow))
    : props.value != null
      ? String(props.value).slice(0, 8)
      : null

  const footerLabel = draft[0]
    ? (props.renderValue?.(draft[0]) ?? optionLabel(src, draft[0]))
    : '未选择'

  return (
    <>
      <div className="flex flex-col gap-1">
        {props.label && <Label>{props.label}</Label>}
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            className="min-w-0 flex-1 justify-between"
            isDisabled={props.isDisabled}
            onPress={() => {
              // 反查未返回时用占位行播种,表格勾选态仍对得上当前值
              setDraft(props.value != null ? [known.get(props.value) ?? ({ id: props.value } as Row)] : [])
              setOpen(true)
            }}
          >
            <span className="truncate">{display ?? <span className="text-muted">{props.placeholder ?? '点击选择…'}</span>}</span>
            <MagnifierIcon />
          </Button>
          {props.value != null && !props.isDisabled && (
            <CloseButton aria-label="清除选择" onPress={() => props.onChange(null, null)} />
          )}
        </div>
      </div>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className={props.dialogClassName ?? 'max-w-4xl'}>
            <Modal.Header>
              <Modal.Heading>{props.dialogTitle ?? `选择${props.label ?? ''}`}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <SynieDataGrid
                resource={src.resource}
                columns={props.gridColumns}
                overrides={props.gridOverrides}
                fixedFilter={props.gridFilter}
                defaultSort={props.gridDefaultSort}
                extraFields={props.gridExtraFields}
                pick="single"
                pickedRows={draft}
                onPickChange={setDraft}
              />
            </Modal.Body>
            <Modal.Footer>
              <span className="mr-auto max-w-[50%] truncate text-sm text-muted">已选:{footerLabel}</span>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button
                isDisabled={draft.length === 0}
                onPress={() => {
                  props.onChange(draft[0].id, draft[0])
                  setOpen(false)
                }}
              >
                确认
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}

function MagnifierIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  )
}
