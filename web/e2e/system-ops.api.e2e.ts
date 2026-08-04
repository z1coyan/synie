import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { loginViaUI } from "./fixtures/session";

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2ESYS${suffix}`;

type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  auditId: string;
  issueTodoId: string;
  receiveTodoId: string;
  bellTodoId: string;
  historyTodoId: string;
};

function postgres(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      pgContainer,
      "psql",
      "-U",
      "synie",
      "-d",
      pgDb,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

function createFixture(): Fixture {
  const raw = postgres(`
    WITH currency AS (
      INSERT INTO bas_currency(name,iso_code,symbol,active)
      VALUES ('${prefix}验收币','${prefix}CUR','¤',true)
      RETURNING id
    ),
    company AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}CO','${prefix}验收公司','${prefix}公司',id FROM currency
      RETURNING id
    ),
    customer AS (
      INSERT INTO sal_customers(code,name,short_name)
      VALUES ('${prefix}CU','${prefix}验收客户','${prefix}客户')
      RETURNING id
    ),
    supplier AS (
      INSERT INTO pur_supplier(code,name,short_name)
      VALUES ('${prefix}SU','${prefix}验收供应商','${prefix}供应商')
      RETURNING id
    ),
    audit AS (
      INSERT INTO sys_audit_log(
        resource,record_id,record_label,action_type,action_name,actor_name,
        company_id,changes,inserted_at
      )
      SELECT
        'sys_setting',gen_random_uuid(),'${prefix}日志记录','update','update',
        '${prefix}操作人',company.id,
        '{"preferred_language":{"from":"en","to":"zh-CN"}}'::jsonb,
        (now() AT TIME ZONE 'utc') + interval '5 minutes'
      FROM company
      RETURNING id
    ),
    issue_todo AS (
      INSERT INTO sys_todo(
        type,source_type,source_id,source_no,party_type,party_id,amount,status,
        source_changed_at,inserted_at,updated_at,company_id
      )
      SELECT
        'issue_invoice','sales.reconciliation',gen_random_uuid(),
        '${prefix}-SR','customer',customer.id,321.45,'active',
        (now() AT TIME ZONE 'utc') + interval '4 minutes',
        (now() AT TIME ZONE 'utc') + interval '4 minutes',
        (now() AT TIME ZONE 'utc') + interval '4 minutes',company.id
      FROM company,customer
      RETURNING id
    ),
    receive_todo AS (
      INSERT INTO sys_todo(
        type,source_type,source_id,source_no,party_type,party_id,amount,status,
        source_changed_at,inserted_at,updated_at,company_id
      )
      SELECT
        'receive_invoice','purchase.reconciliation',gen_random_uuid(),
        '${prefix}-PR','supplier',supplier.id,98.76,'active',
        (now() AT TIME ZONE 'utc') + interval '3 minutes',
        (now() AT TIME ZONE 'utc') + interval '3 minutes',
        (now() AT TIME ZONE 'utc') + interval '3 minutes',company.id
      FROM company,supplier
      RETURNING id
    ),
    bell_todo AS (
      INSERT INTO sys_todo(
        type,source_type,source_id,source_no,party_type,party_id,amount,status,
        source_changed_at,inserted_at,updated_at,company_id
      )
      SELECT
        'issue_invoice','sales.reconciliation',gen_random_uuid(),
        '${prefix}-BELL','customer',customer.id,10,'active',
        (now() AT TIME ZONE 'utc') + interval '2 minutes',
        (now() AT TIME ZONE 'utc') + interval '2 minutes',
        (now() AT TIME ZONE 'utc') + interval '2 minutes',company.id
      FROM company,customer
      RETURNING id
    ),
    history_todo AS (
      INSERT INTO sys_todo(
        type,source_type,source_id,source_no,party_type,party_id,amount,status,
        closed_reason,source_changed_at,closed_at,inserted_at,updated_at,company_id
      )
      SELECT
        'issue_invoice','sales.reconciliation',gen_random_uuid(),
        '${prefix}-HISTORY','customer',customer.id,50,'closed','unconfirm',
        (now() AT TIME ZONE 'utc') - interval '2 minutes',
        (now() AT TIME ZONE 'utc') - interval '1 minute',
        (now() AT TIME ZONE 'utc') - interval '2 minutes',
        (now() AT TIME ZONE 'utc') - interval '1 minute',company.id
      FROM company,customer
      RETURNING id
    )
    SELECT
      currency.id::text,company.id::text,customer.id::text,supplier.id::text,
      audit.id::text,issue_todo.id::text,receive_todo.id::text,
      bell_todo.id::text,history_todo.id::text
    FROM currency,company,customer,supplier,audit,issue_todo,receive_todo,
         bell_todo,history_todo;
  `);
  const [
    currencyId,
    companyId,
    customerId,
    supplierId,
    auditId,
    issueTodoId,
    receiveTodoId,
    bellTodoId,
    historyTodoId,
  ] = raw.split("|");
  expect(
    currencyId &&
      companyId &&
      customerId &&
      supplierId &&
      auditId &&
      issueTodoId &&
      receiveTodoId &&
      bellTodoId &&
      historyTodoId,
    "系统运维浏览器夹具创建失败",
  ).toBeTruthy();
  return {
    currencyId: currencyId!,
    companyId: companyId!,
    customerId: customerId!,
    supplierId: supplierId!,
    auditId: auditId!,
    issueTodoId: issueTodoId!,
    receiveTodoId: receiveTodoId!,
    bellTodoId: bellTodoId!,
    historyTodoId: historyTodoId!,
  };
}

function cleanup(fixture: Fixture | null): void {
  if (!fixture) return;
  postgres(`
    DELETE FROM sys_todo WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM sys_audit_log WHERE id='${fixture.auditId}'::uuid;
    DELETE FROM sal_customers WHERE id='${fixture.customerId}'::uuid;
    DELETE FROM pur_supplier WHERE id='${fixture.supplierId}'::uuid;
    DELETE FROM bas_company WHERE id='${fixture.companyId}'::uuid;
    DELETE FROM bas_currency WHERE id='${fixture.currencyId}'::uuid;
  `);
  const remaining = postgres(`
    SELECT
      (SELECT count(*) FROM bas_company WHERE name LIKE '${prefix}%') +
      (SELECT count(*) FROM bas_currency WHERE name LIKE '${prefix}%') +
      (SELECT count(*) FROM sys_audit_log WHERE record_label LIKE '${prefix}%') +
      (SELECT count(*) FROM sys_todo WHERE source_no LIKE '${prefix}%');
  `);
  expect(Number(remaining), "系统运维 E2E 夹具必须 cleanup=0").toBe(0);
}

test.setTimeout(120_000);

test("操作日志、待办页与铃铛全程使用 Go REST", async ({ page }) => {
  let fixture: Fixture | null = null;
  const graphql: string[] = [];
  const systemREST: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path === "/graphql") {
      graphql.push(`${req.method()} ${path} ${req.postData() ?? ""}`);
    }
    if (
      path === "/api/v1/meta/resources/sysAuditLogs" ||
      path.startsWith("/api/v1/system/audit-logs") ||
      path.startsWith("/api/v1/todos")
    ) {
      systemREST.push(`${req.method()} ${path}`);
    }
  });

  try {
    fixture = createFixture();
    await loginViaUI(page);

    const bell = page.getByRole("button", { name: /^待办(?:,\d+ 条未读)?$/ });
    await expect(bell).toBeVisible();
    const recentResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/api/v1/todos/query" &&
        candidate.request().postData()?.includes('"tab":"recent"') === true,
    );
    await bell.click();
    expect((await recentResponse).ok()).toBeTruthy();
    const recentIssue = page
      .locator("li")
      .filter({ hasText: `${prefix}-SR` })
      .first();
    await expect(recentIssue).toBeVisible();
    await expect(recentIssue).toContainText(`${prefix}验收客户`);
    await page.keyboard.press("Escape");

    await page.goto("/system/logs");
    const grid = page.getByRole("grid", { name: "sysAuditLogs 数据表格" });
    await expect(
      grid,
      `页面运行时错误: ${pageErrors.join(" | ")}`,
    ).toBeVisible();
    const search = page.getByRole("searchbox", { name: "搜索" });
    await search.fill(`${prefix}日志记录`);
    const auditRow = page
      .getByRole("row")
      .filter({ hasText: `${prefix}日志记录` });
    await expect(auditRow).toContainText("系统设置");
    await expect(auditRow).toContainText("1 项变更");
    await auditRow.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "查看", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "操作日志详情" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByText(`${prefix}日志记录`, { exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText("首选语言", { exact: false })).toBeVisible();
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();

    await page.goto("/todos");
    await expect(
      page.getByRole("heading", { name: "待办", exact: true }),
    ).toBeVisible();
    const issueRow = page
      .locator("tbody tr")
      .filter({ hasText: `${prefix}-SR` });
    const receiveRow = page
      .locator("tbody tr")
      .filter({ hasText: `${prefix}-PR` });
    await expect(issueRow).toContainText("开票");
    await expect(issueRow).toContainText(`${prefix}验收客户`);
    await expect(issueRow).toContainText(`${prefix}公司`);
    await expect(receiveRow).toContainText("收票");

    const dismissResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname ===
          `/api/v1/todos/${fixture!.receiveTodoId}/dismiss`,
    );
    await receiveRow.getByRole("button", { name: "忽略", exact: true }).click();
    expect((await dismissResponse).ok()).toBeTruthy();
    await expect(receiveRow).toBeHidden();

    await page.getByRole("tab", { name: "历史", exact: true }).click();
    const historyRow = page
      .locator("tbody tr")
      .filter({ hasText: `${prefix}-HISTORY` });
    await expect(historyRow).toBeVisible();
    await expect(historyRow).toContainText("已关闭");
    await expect(historyRow).toContainText("撤回确认");

    await page.getByRole("tab", { name: "活跃", exact: true }).click();
    const activeIssue = page
      .locator("tbody tr")
      .filter({ hasText: `${prefix}-SR` });
    const readResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname ===
          `/api/v1/todos/${fixture!.issueTodoId}/read`,
    );
    await activeIssue
      .getByRole("button", { name: `${prefix}-SR`, exact: true })
      .click();
    expect((await readResponse).ok()).toBeTruthy();
    await expect(page).toHaveURL(
      /\/scm\/sales-reconciliations\/reconciliations/,
    );

    expect(pageErrors, "系统运维消费面不应产生运行时错误").toEqual([]);
    expect(graphql, "操作日志、待办与铃铛不得发业务 GraphQL").toEqual([]);
    for (const endpoint of [
      "GET /api/v1/meta/resources/sysAuditLogs",
      "POST /api/v1/system/audit-logs/query",
      "GET /api/v1/todos/unread-count",
      "POST /api/v1/todos/query",
      `POST /api/v1/todos/${fixture.issueTodoId}/read`,
      `POST /api/v1/todos/${fixture.receiveTodoId}/dismiss`,
    ]) {
      expect(
        systemREST.some((entry) => entry === endpoint),
        `浏览器未观察到 ${endpoint}`,
      ).toBe(true);
    }
  } finally {
    cleanup(fixture);
  }
});
