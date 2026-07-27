import { defineConfig, devices } from '@playwright/test'

/**
 * 权限浏览器薄冒烟配置(authz-e2e 工单11)。
 *
 * **遗留套件(冻结)**:依赖 Elixir `backend/` 演示库与 GraphQL 管理动线,Web Go-only
 * 切流(2026-07-26)后不再维护,随 `backend/` 删除一并清理。现行验收走
 * `playwright.go.config.ts`(各 `*.go.e2e.ts`),一键起栈见 `e2e/run-smoke.sh`。
 */
export default defineConfig({
  testDir: './e2e',
  // 用 .e2e.ts 后缀:避开 `bun test` 默认的 *.test/*.spec 发现(否则 bun 会误跑
  // Playwright spec 并在 test.beforeAll 处报错),前端 CI 的 `bun test` 只跑 app/*.test.ts
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // 单 worker 串行:共用一个演示会计 + 演示库数据,避免并发互扰
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
