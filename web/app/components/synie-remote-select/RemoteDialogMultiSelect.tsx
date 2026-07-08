import { useState } from 'react'
import { Button, Chip, CloseButton, Label, Modal } from '@heroui/react'
import { SynieDataGrid } from '../synie-data-grid/SynieDataGrid'
import type { Row } from '../synie-data-grid/types'
import { optionLabel, resolveSource } from './remote-query'
import { useRemoteRecords } from './use-remote'
import type { RemoteMultiSelectProps } from './RemoteMultiSelect'

export interface RemoteDialogMultiSelectProps extends RemoteMultiSelectProps {
  dialogTitle?: string
}

export function RemoteDialogMultiSelect(props: RemoteDialogMultiSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Row[]>([])

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value.filter((id) => !known.has(id)))
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const labelOf = (row: Row) => optionLabel(src, row)

  const openDialog = () => {
    // 草稿从当前值起步;反查未返回的 id 用占位行保住(面板经 optionLabel 兜底显示截断 id),确认不丢数据
    setDraft(props.value.map((id) => known.get(id) ?? ({ id } as Row)))
    setOpen(true)
  }

  /** 已选面板条目(桌面右栏与移动端 chips 共用移除逻辑) */
  const removeDraft = (id: string) => setDraft((prev) => prev.filter((r) => r.id !== id))

  return (
    <>
      <div className="flex flex-col gap-1">
        {props.label && <Label>{props.label}</Label>}
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            className="min-w-0 flex-1 justify-between"
            isDisabled={props.isDisabled}
            onPress={openDialog}
          >
            <span className="truncate">
              {props.value.length > 0 ? (
                `已选 ${props.value.length} 项`
              ) : (
                <span className="text-muted">{props.placeholder ?? '点击选择…'}</span>
              )}
            </span>
            <MagnifierIcon />
          </Button>
          {props.value.length > 0 && !props.isDisabled && (
            <CloseButton aria-label="清除选择" onPress={() => props.onChange([], [])} />
          )}
        </div>
      </div>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-5xl">
            <Modal.Header>
              <Modal.Heading>{props.dialogTitle ?? `选择${props.label ?? ''}`}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {/* 移动端(<lg):已选转为表格上方 chips 行 */}
              {draft.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-1 lg:hidden">
                  {draft.map((row) => (
                    <Chip key={row.id} size="sm" className="pr-1">
                      <Chip.Label>{labelOf(row)}</Chip.Label>
                      <CloseButton
                        aria-label={`移除 ${labelOf(row)}`}
                        className="h-4 w-4 [&_svg]:size-3"
                        onPress={() => removeDraft(row.id)}
                      />
                    </Chip>
                  ))}
                </div>
              )}
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  <SynieDataGrid resource={src.resource} pick="multiple" pickedRows={draft} onPickChange={setDraft} />
                </div>
                {/* 桌面右侧已选面板:跨页/跨搜索累积,可单个移除 */}
                <aside className="hidden w-56 shrink-0 flex-col gap-2 lg:flex">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">已选 {draft.length} 项</span>
                    {draft.length > 0 && (
                      <Button size="sm" variant="ghost" onPress={() => setDraft([])}>
                        清空
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 overflow-y-auto">
                    {draft.length === 0 && <span className="text-sm text-muted">在左侧勾选记录</span>}
                    {draft.map((row) => (
                      <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border border-separator px-2 py-1">
                        <span className="truncate text-sm">{labelOf(row)}</span>
                        <CloseButton aria-label={`移除 ${labelOf(row)}`} className="h-4 w-4 [&_svg]:size-3" onPress={() => removeDraft(row.id)} />
                      </div>
                    ))}
                  </div>
                </aside>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button
                onPress={() => {
                  props.onChange(draft.map((r) => r.id), draft)
                  setOpen(false)
                }}
              >
                确认({draft.length})
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
