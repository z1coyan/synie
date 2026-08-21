/**
 * 封路特征化测试（工单 04）：`modules/**` 禁止 import 旧授权原语。
 *
 * 新体系下模块零鉴权代码——路由挂 `guard(resource, action)`，服务收 Permit，
 * 列表/单记录/写入三个执行点由平台拥有。
 *
 * **扫荡已完成（工单 09-12）**：豁免清单为空集，全库 `modules/**` 零旧原语。
 * 本清单不再是进度表，而是「不得回退」的守卫——任何文件（新的或存量的）都加不进来。
 */
import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

/** 旧授权原语（platform/authz/actor.ts 与 db/list.ts 的过渡层导出，两文件已随工单 09-12 删除；本清单防回退） */
const FORBIDDEN = [
  'requirePermission',
  'hasPermission',
  'companyScopeWhere',
  'canAccessCompany',
  'requireCompanyAccess',
  'companyFilter',
] as const

/**
 * 豁免清单：**空集**（工单 12 扫荡完成后清零）。
 * 任何文件都不得再进入——新代码走 Permit，加不进来说明设计对了；
 * 存量文件加进来说明有判定没搬走，该修的是文件不是清单。
 */
const EXEMPT = new Set<string>([])

async function moduleFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob('modules/**/*.ts').scan({ cwd: 'src' })) {
    if (!file.endsWith('.test.ts')) files.push(file)
  }
  return files.sort()
}

describe('封路：modules 不得使用旧授权原语', () => {
  const pattern = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`)

  test('非豁免模块文件零命中', async () => {
    const offenders: string[] = []
    for (const file of await moduleFiles()) {
      if (EXEMPT.has(file)) continue
      const text = await Bun.file(`src/${file}`).text()
      if (pattern.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test('豁免清单无僵尸项（空集恒真；回退加行会被本例与上例双向卡住）', async () => {
    const files = new Set(await moduleFiles())
    const stale: string[] = []
    for (const file of EXEMPT) {
      if (!files.has(file)) {
        stale.push(`${file}（文件已不存在）`)
        continue
      }
      const text = await Bun.file(`src/${file}`).text()
      if (!pattern.test(text)) stale.push(`${file}（已无旧原语，可移出豁免）`)
    }
    expect(stale).toEqual([])
  })

  test('豁免清零（扫荡完成态：全库 modules 无旧原语）', () => {
    expect(EXEMPT.size).toBe(0)
  })
})
