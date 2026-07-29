// 卡片模式纯函数自检 —— import 即自执行,失败 process.exit(1)
// 覆盖工单 01 验收:位置约定、mobileRole 优先级、hide、列数不足、显式角色挤占摘要位
import { cardFields } from './card-fields'
import type { GridColumnMeta } from './types'

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

console.log('card-mode-checks ok')
