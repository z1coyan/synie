import type { ReactNode } from 'react'
import {
  Autocomplete,
  Collection,
  EmptyState,
  ListBox,
  ListBoxLoadMoreItem,
  SearchField,
  Spinner,
} from '@heroui/react'
import type { Row } from '../synie-data-grid/types'
import { optionLabel, type ResolvedSource } from './remote-query'
import type { useRemoteOptions } from './use-remote'

/** 桌面断点(lg,1024px)才自动聚焦搜索框,避免移动端弹层一打开就唤起键盘 */
function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
}

/**
 * 弹层内容:受控搜索框 + 选项列表 + 无限滚动,单/多选共用。
 * 搜索框在弹层内(Autocomplete.Filter),搜索已由服务端 contains 完成,
 * filter 直通(不传 filter 函数)关掉 ListBox 的客户端二次过滤。
 */
export function RemoteOptionsPopover({
  src,
  draft,
  onDraft,
  options,
  renderItem,
}: {
  src: ResolvedSource
  draft: string
  onDraft: (v: string) => void
  options: ReturnType<typeof useRemoteOptions>
  renderItem?: (row: Row) => ReactNode
}) {
  const rows = (options.data?.pages ?? []).flatMap((p) => p.results)
  return (
    <Autocomplete.Popover>
      <Autocomplete.Filter inputValue={draft} onInputChange={onDraft}>
        <SearchField aria-label="搜索" autoFocus={isDesktop()}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="输入关键字搜索…" />
            {options.isFetching && !options.isFetchingNextPage ? <Spinner size="sm" /> : <SearchField.ClearButton />}
          </SearchField.Group>
        </SearchField>
        <ListBox aria-label="选项" renderEmptyState={() => <EmptyState>{options.isPending ? '加载中…' : '无匹配记录'}</EmptyState>}>
          <Collection items={rows}>
            {(row: Row) => (
              <ListBox.Item id={row.id} textValue={optionLabel(src, row)}>
                {renderItem ? renderItem(row) : optionLabel(src, row)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )}
          </Collection>
          {options.hasNextPage && (
            <ListBoxLoadMoreItem isLoading={options.isFetchingNextPage} onLoadMore={() => options.fetchNextPage()}>
              <Spinner size="sm" />
            </ListBoxLoadMoreItem>
          )}
        </ListBox>
      </Autocomplete.Filter>
    </Autocomplete.Popover>
  )
}
