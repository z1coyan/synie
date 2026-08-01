/**
 * Playwright 全局 teardown:读回 setup 落的上下文,清理演示会计角色/用户。
 * 演示角色临时造、跑完即清,不进迁移种子(见 spec.md 载具与缝一节)。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { DEMO_STATE_PATH } from './global-setup'
import { teardownDemoAccountant, type DemoContext } from './helpers/admin-flow'

export default async function globalTeardown() {
  if (!existsSync(DEMO_STATE_PATH)) return
  const ctx = JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoContext
  await teardownDemoAccountant(ctx)
  rmSync(DEMO_STATE_PATH, { force: true })
}
