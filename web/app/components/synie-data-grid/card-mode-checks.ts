// 卡片模式纯函数自检 —— import 即自执行,失败 process.exit(1)
// 覆盖工单 01 验收:位置约定、mobileRole 优先级、hide、列数不足、显式角色挤占摘要位
import { cardFields } from './card-fields'
import { hasMoreRows, mergeLoadedRows } from './load-more'
import { visibleOnCard } from './mobile-actions'
import { toggleSort } from './query'
import type { GridColumnMeta, Row } from './types'

const col = (name: string): GridColumnMeta => ({
  name,
  type: 'string',
  label: name,
  sortable: true,
  filterable: true,
  enumOptions: null,
  ref: null,
})

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const five = ['a', 'b', 'c', 'd', 'e'].map(col)

// 位置约定:第 1 列标题、第 2 列副标题、第 3-5 列摘要
eq(cardFields(five, {}), { title: 'a', subtitle: 'b', summary: ['c', 'd', 'e'] }, '位置约定五列')

// 摘要至多 3 列,第 6 列起不上卡片
eq(
  cardFields(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(col), {}),
  { title: 'a', subtitle: 'b', summary: ['c', 'd', 'e'] },
  '摘要封顶 3 列'
)

// 列数不足:单列只有标题,两列无摘要
eq(cardFields([col('a')], {}), { title: 'a', subtitle: null, summary: [] }, '单列')
eq(cardFields([col('a'), col('b')], {}), { title: 'a', subtitle: 'b', summary: [] }, '两列')
eq(cardFields([], {}), { title: null, subtitle: null, summary: [] }, '空列')

// hide:不上卡片,后续列位置顺延
eq(
  cardFields(five, { a: 'hide' }),
  { title: 'b', subtitle: 'c', summary: ['d', 'e'] },
  'hide 首列顺延'
)
eq(
  cardFields(five, { c: 'hide' }),
  { title: 'a', subtitle: 'b', summary: ['d', 'e'] },
  'hide 摘要列'
)

// 显式 title 优先于位置约定,位置列顺延进副标题/摘要(显式角色挤占摘要位)
eq(
  cardFields(five, { c: 'title' }),
  { title: 'c', subtitle: 'a', summary: ['b', 'd', 'e'] },
  '显式 title 挤占'
)

// 显式 subtitle
eq(
  cardFields(five, { d: 'subtitle' }),
  { title: 'a', subtitle: 'd', summary: ['b', 'c', 'e'] },
  '显式 subtitle'
)

// 显式 title+subtitle 齐备,其余列按原序进摘要
eq(
  cardFields(five, { e: 'title', b: 'subtitle' }),
  { title: 'e', subtitle: 'b', summary: ['a', 'c', 'd'] },
  '显式 title+subtitle'
)

// 显式 summary 提前进入,位置填充列补足 3 位
eq(
  cardFields(['a', 'b', 'c', 'd', 'e', 'f'].map(col), { f: 'summary' }),
  { title: 'a', subtitle: 'b', summary: ['f', 'c', 'd'] },
  '显式 summary 提前'
)

// 误配两个显式 title:首个生效,其余显式列退出位置池、不抢副标题/摘要位
eq(
  cardFields(five, { a: 'title', b: 'title' }),
  { title: 'a', subtitle: 'c', summary: ['d', 'e'] },
  '多显式 title 不回落'
)

// ---- 加载更多(ticket 02) ----
const row = (id: string): Row => ({ id }) as Row
const page1 = [row('a'), row('b')]
const page2 = [row('c'), row('d')]

// 第 1 页整体替换:查询条件变更后旧累积被丢弃
eq(mergeLoadedRows([row('x'), row('y')], page1, 1), page1, '第 1 页替换')
// 后续页追加在已有之后
eq(mergeLoadedRows(page1, page2, 2), [...page1, ...page2], '第 2 页追加')
// 按 id 去重:翻页竞态/重复抵达不产生重复卡片
eq(mergeLoadedRows(page1, [row('b'), row('c')], 2), [row('a'), row('b'), row('c')], '追加去重')
// 空累积追加(极端:进入卡片模式时已在第 N 页,上层已先重置回第 1 页,此处兜底语义为追加)
eq(mergeLoadedRows([], page2, 3), page2, '空累积追加')

eq(hasMoreRows(20, 132), true, '未加载完')
eq(hasMoreRows(132, 132), false, '恰好加载完')
eq(hasMoreRows(140, 132), false, '超总数(批量删除后总数收缩)')

// ---- 排序选择器(ticket 03):新列顺序 → 逆序 → 取消,换列重新顺序 ----
eq(toggleSort(null, 'code'), { column: 'code', direction: 'ascending' }, '空→顺序')
eq(
  toggleSort({ column: 'code', direction: 'ascending' }, 'code'),
  { column: 'code', direction: 'descending' },
  '顺序→逆序'
)
eq(toggleSort({ column: 'code', direction: 'descending' }, 'code'), null, '逆序→取消')
eq(
  toggleSort({ column: 'code', direction: 'descending' }, 'name'),
  { column: 'name', direction: 'ascending' },
  '换列重新顺序'
)

// ---- 动作面 mobile 标记(ticket 04) ----
const act = (key: string, mobile?: boolean) => ({ key, mobile })

// 行内默认全保留,mobile:false 拿下
eq(visibleOnCard([act('view'), act('print')], 'row').map((a) => a.key), ['view', 'print'], '行内默认保留')
eq(visibleOnCard([act('view'), act('print', false)], 'row').map((a) => a.key), ['view'], '行内 mobile:false 拿下')
// 工具栏/批量默认全隐藏,mobile:true 放上
eq(visibleOnCard([act('create'), act('approve', true)], 'toolbar').map((a) => a.key), ['approve'], '工具栏仅 mobile:true')
eq(visibleOnCard([act('batch_delete'), act('batch_approve', true)], 'bulk').map((a) => a.key), ['batch_approve'], '批量仅 mobile:true')
// mobile:true 在行内面无害(默认本就保留)
eq(visibleOnCard([act('audit', true)], 'row').map((a) => a.key), ['audit'], '行内 mobile:true 仍保留')

console.log('card-mode-checks ok')
