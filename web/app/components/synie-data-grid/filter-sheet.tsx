import { Sheet } from '@heroui-pro/react'
import { Button, ListBox } from '@heroui/react'
import { toggleSort } from './query'
import type { GridColumnMeta, SortState } from './types'

/**
 * 卡片模式排序 Sheet(底部弹层):点按列循环 顺序→逆序→取消(toggleSort,与桌面表头三态同语义);
 * 与桌面落同一个 SortState,两侧改动互见。
 */
export function CardSortSheet({
  isOpen,
  onOpenChange,
  columns,
  sort,
  onSortChange,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  columns: GridColumnMeta[]
  sort: SortState | null
  onSortChange: (next: SortState | null) => void
}) {
  const sortable = columns.filter((c) => c.sortable)
  return (
    // isHandleOnly:正文全是交互控件,拖拽关闭只认把手
    <Sheet isOpen={isOpen} onOpenChange={onOpenChange} isHandleOnly>
      <Sheet.Backdrop>
        <Sheet.Content className="mx-auto max-h-[80vh] w-full max-w-[480px]">
          <Sheet.Dialog aria-label="排序">
            <Sheet.Handle />
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>排序</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body className="overflow-y-auto">
              {/* 排序列用 ListBox 动作语义(点按即触发,选中态不落 ListBox;方向指示自 SortState 渲染),
                  与桌面表头排序落同一 SortState */}
              <ListBox
                aria-label="排序列"
                selectionMode="none"
                onAction={(key) => onSortChange(toggleSort(sort, String(key)))}
              >
                {sortable.map((col) => {
                  const active = sort?.column === col.name ? sort.direction : null
                  return (
                    <ListBox.Item key={col.name} id={col.name} textValue={col.label}>
                      <span className="flex flex-1 items-center justify-between">
                        <span>{col.label}</span>
                        <span className="text-muted" aria-hidden>
                          {active === 'ascending' ? '↑ 升序' : active === 'descending' ? '↓ 降序' : ''}
                        </span>
                      </span>
                    </ListBox.Item>
                  )
                })}
              </ListBox>
              {sortable.length === 0 && <p className="text-sm text-muted">该列表没有可排序的列。</p>}
            </Sheet.Body>
            <Sheet.Footer>
              <Sheet.Close>
                <Button variant="primary" className="w-full">
                  完成
                </Button>
              </Sheet.Close>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}
