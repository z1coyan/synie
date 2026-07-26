import { defineConfig, devices } from '@playwright/test'

/**
 * Go API 竖切浏览器测试。与仍依赖 Elixir 演示库的旧 authz 冒烟隔离，
 * 不运行其 globalSetup/globalTeardown。
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.go.e2e.ts',
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
