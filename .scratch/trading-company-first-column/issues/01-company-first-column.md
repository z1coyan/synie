# Issue 01: 购销单据公司首列 Implementation Plan

**Status:** ready-for-agent
**Type:** task
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让采购订单、采购报价、销售报价、销售订单的条目表与整单表都以“公司”为第一列。

**Architecture:** 复用四类条目资源已有的 `companyId` 外键字段及 `SynieDataGrid` 默认外键渲染、筛选和排序能力，仅调整四张条目表的有序列白名单。整单表已有该列，不改代码；用浏览器契约测试覆盖八个 Tab，并同步产品文档与术语口径。

**Tech Stack:** React 19、TanStack Start、HeroUI Pro DataGrid、Playwright、Bun、TypeScript。

## Global Constraints

- 公司必须是四个页面所有业务表格的第一列。
- 直接复用现有 `companyId`；不修改数据库、GraphQL 资源、权限或业务逻辑。
- 整单表已经合规，不做无意义改写。
- 产品文档使用中文，并同步根目录 `CONTEXT.md`。

---

### Task 1: 浏览器列顺序契约

**Files:**
- Create: `web/e2e/trading-company-column.e2e.ts`

**Interfaces:**
- Consumes: Playwright `page`；`DEMO_STATE_PATH` 中的 `adminToken`；应用 localStorage token 键 `synie:token`。
- Produces: 八个购销 Tab 的首列表头均为“公司”的可执行浏览器契约。

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { DEMO_STATE_PATH } from './global-setup'
import type { DemoContext } from './helpers/admin-flow'

const TOKEN_KEY = 'synie:token'
const ROUTES = [
  '/scm/purchase/items',
  '/scm/purchase/orders',
  '/scm/purchase-quotations/items',
  '/scm/purchase-quotations/quotations',
  '/scm/quotations/items',
  '/scm/quotations/quotations',
  '/scm/sales-orders/items',
  '/scm/sales-orders/orders',
] as const

let demo: DemoContext

test.beforeAll(() => {
  demo = JSON.parse(readFileSync(DEMO_STATE_PATH, 'utf8')) as DemoContext
})

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key, token]) => window.localStorage.setItem(key, token),
    [TOKEN_KEY, demo.adminToken] as const,
  )
})

for (const route of ROUTES) {
  test(`${route} 首列为公司`, async ({ page }) => {
    await page.goto(route)
    await expect(page.getByRole('columnheader').first()).toHaveText('公司')
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./e2e/run-smoke.sh trading-company-column.e2e.ts`

Expected: 四个 `items` 路由 FAIL，首列表头实际为“订单号”或“报价单号”；四个整单路由 PASS。

### Task 2: 四张条目表增加公司首列

**Files:**
- Modify: `web/app/routes/_app/scm/purchase/items.tsx:15-39`
- Modify: `web/app/routes/_app/scm/purchase-quotations/items.tsx:19-39`
- Modify: `web/app/routes/_app/scm/quotations/items.tsx:15-35`
- Modify: `web/app/routes/_app/scm/sales-orders/items.tsx:15-39`
- Test: `web/e2e/trading-company-column.e2e.ts`

**Interfaces:**
- Consumes: 条目资源已有 `companyId` 字段和 GridMeta 公司外键元数据。
- Produces: 四张条目表的有序列白名单均以 `companyId` 开头。

- [ ] **Step 1: Implement the minimal column changes**

在四个 `GRID_COLUMNS` 数组中，把以下元素插入现有订单号/报价单号之前：

```ts
'companyId',
```

同时把四处注释从“`companyId` 不进表格”改为“`companyId` 作为跨公司归属首列”。其余列顺序保持不变。

- [ ] **Step 2: Run the browser contract test**

Run: `./e2e/run-smoke.sh trading-company-column.e2e.ts`

Expected: 八个路由全部 PASS；每个 DataGrid 的首列表头均为“公司”。

- [ ] **Step 3: Run TypeScript validation**

Run: `bun run typecheck`

Expected: exit code 0，无 TypeScript 错误。

### Task 3: 同步业务文档与术语口径

**Files:**
- Modify: `docs/产品文档/采购订单.md:27-32`
- Modify: `docs/产品文档/采购报价.md:21-26`
- Modify: `docs/产品文档/销售报价.md:21-25`
- Modify: `docs/产品文档/销售订单.md:23-27`
- Modify: `CONTEXT.md:102-132`

**Interfaces:**
- Consumes: 已验证的 UI 行为。
- Produces: 产品文档和唯一术语上下文对公司首列口径的准确说明。

- [ ] **Step 1: Update the four product documents**

把四篇“列表视图”中的条目字段枚举改为以“公司、所属订单号/报价单号”开头，并明确条目与整单两个 Tab 均以公司为第一列。

- [ ] **Step 2: Update the root context**

在购销单据术语段加入以下统一口径：

```md
- **购销单据公司首列**：采购报价、采购订单、销售报价、销售订单的条目与整单列表均以单据所属公司为第一列；条目直接使用随父单冗余的公司字段，便于跨内部公司浏览与筛选。
```

- [ ] **Step 3: Run focused regression checks**

Run: `bun test`

Expected: exit code 0，全部前端单元测试通过。

Run: `bun run check`

Expected: exit code 0，前端组件检查全部通过。

- [ ] **Step 4: Final browser smoke**

Run: `./e2e/run-smoke.sh trading-company-column.e2e.ts`

Expected: 八个购销 Tab 全部 PASS；具备 `base.company:read` 时条目表显示公司名称而非 UUID，公司列筛选入口可打开，后续列顺序不变；无该权限时沿用既有元数据降级规则。
