import { defineConfig, devices } from '@playwright/test'

/** Go REST 迁移独立验收：不依赖旧 Elixir GraphQL 全局夹具。 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.go.e2e.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
