/**
 * Playwright 全局 setup:跑一次权限管理动线(建演示会计),把上下文落到
 * `.auth/demo.json` 供各 spec 与 teardown 读取。动线本身即断言——失败即整轮红。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setupDemoAccountant } from './helpers/admin-flow'

export const DEMO_STATE_PATH = join(import.meta.dirname, '.auth', 'demo.json')

export default async function globalSetup() {
  const ctx = await setupDemoAccountant()
  mkdirSync(dirname(DEMO_STATE_PATH), { recursive: true })
  writeFileSync(DEMO_STATE_PATH, JSON.stringify(ctx, null, 2))
  // eslint-disable-next-line no-console
  console.log(`[e2e] 演示会计已建:${ctx.username} / 公司 ${ctx.companyId} / 样本账户「${ctx.sampleAlias}」`)
}
