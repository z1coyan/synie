import { defineConfig, devices } from '@playwright/test'

/**
 * Bun/Hono API 竖切浏览器测试。
 * 不运行遗留 Elixir authz 冒烟的 globalSetup/globalTeardown。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.api.e2e.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3011',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
