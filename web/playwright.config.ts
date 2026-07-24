import { defineConfig, devices } from '@playwright/test'

/**
 * 权限浏览器薄冒烟配置(authz-e2e 工单11)。
 *
 * **不进 PR CI**:本冒烟依赖前后端同起 + HeroUI Pro token + 演示库数据,脆性天然
 * 高于 API 矩阵;覆盖率全压在 API 层(见 spec.md)。按需本地跑:`bun run e2e`
 * (一键起栈见 `e2e/run-smoke.sh`),或对已起的栈跑 `E2E_BASE_URL=... npx playwright test`。
 * nightly 化留作后议。
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
