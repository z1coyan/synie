import type { Page } from '@playwright/test'

/** 等待 React effect 已执行，避免只操作到不可交互的 SSR HTML。 */
export async function waitForHydration(page: Page) {
  await page.locator('html[data-synie-hydrated="true"]').waitFor()
}
