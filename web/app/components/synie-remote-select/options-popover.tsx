import type { ReactNode } from 'react'
import { DialogContext } from 'react-aria-components'
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

// 默认下拉项:label 单行;数据源声明了副行字段(如员工的 工号/考勤机编号)则加灰色副行
function defaultItem(src: ResolvedSource, row: Row) {
  const subtitle = src.itemSubtitleFields
    .map((f) => row[f])
    .filter((v) => v != null && v !== '')
    .join(' · ')

  if (!subtitle) return optionLabel(src, row)

  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate">{optionLabel(src, row)}</span>
      <span className="truncate text-xs text-muted">{subtitle}</span>
    </div>
  )
}
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
    // HeroUI 弹层内部的 RAC Dialog 无标签且不透传 aria-label,会刷"Dialog 必须有标题"
    // 警告;经 DialogContext 从外层注入 aria-label(RAC useContextProps 合并)
    <DialogContext.Provider value={{ 'aria-label': '选项列表' }}>
      <Autocomplete.Popover>
        <Autocomplete.Filter inputValue={draft} onInputChange={onDraft}>
          <SearchField aria-label="搜索" autoFocus={isDesktop()}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="输入关键字搜索…" />
              {options.isFetching && !options.isFetchingNextPage ? <Spinner size="sm" /> : <SearchField.ClearButton />}
            </SearchField.Group>
          </SearchField>
          <ListBox
            aria-label="选项"
            renderEmptyState={() => (
              <EmptyState>
                {options.isError ? (
                  // gqlFetch 抛错时不能落到「无匹配记录」——那是误报,掩盖了真实的请求失败
                  <span className="text-danger">加载失败:{(options.error as Error).message}</span>
                ) : options.isPending ? (
                  '加载中…'
                ) : (
                  '无匹配记录'
                )}
              </EmptyState>
            )}
          >
            <Collection items={rows}>
              {(row: Row) => (
                <ListBox.Item id={row.id} textValue={optionLabel(src, row)}>
                  {renderItem ? renderItem(row) : defaultItem(src, row)}
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
    </DialogContext.Provider>
  )
}
