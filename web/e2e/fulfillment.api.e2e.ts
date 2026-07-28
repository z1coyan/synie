import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EFL${suffix}`;

type Fixture = {
  companyId: string;
  customerId: string;
  supplierId: string;
  debitAccountId: string;
  creditAccountId: string;
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
      VALUES ('${prefix}验收币种','${prefix}CUR','¤',true)
      RETURNING id
    ),
    company AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}CO','${prefix}验收公司','${prefix}CO',id FROM currency
      RETURNING id
    ),
    customer AS (
      INSERT INTO sal_customers(code,name,short_name)
      VALUES ('${prefix}CU','${prefix}验收客户','${prefix}CU')
      RETURNING id
    ),
    supplier AS (
      INSERT INTO pur_supplier(code,name,short_name)
      VALUES ('${prefix}SU','${prefix}验收供应商','${prefix}SU')
      RETURNING id
    ),
    debit_account AS (
      INSERT INTO bas_account(code,name,direction,is_group,active,company_id,currency_id,role)
      SELECT '${prefix}D','${prefix}未开票应收','debit',false,true,company.id,currency.id,'unbilled_receivable'
      FROM company,currency
      RETURNING id
    ),
    credit_account AS (
      INSERT INTO bas_account(code,name,direction,is_group,active,company_id,currency_id,role)
      SELECT '${prefix}C','${prefix}未开票应付','credit',false,true,company.id,currency.id,'unbilled_payable'
      FROM company,currency
      RETURNING id
    )
    SELECT company.id::text,customer.id::text,supplier.id::text,
           debit_account.id::text,credit_account.id::text
    FROM company,customer,supplier,debit_account,credit_account;
  `);
  const [companyId, customerId, supplierId, debitAccountId, creditAccountId] =
    raw.split("|");
  expect(
    companyId && customerId && supplierId && debitAccountId && creditAccountId,
    "履约浏览器夹具创建失败",
  ).toBeTruthy();
  return {
    companyId: companyId!,
    customerId: customerId!,
    supplierId: supplierId!,
    debitAccountId: debitAccountId!,
    creditAccountId: creditAccountId!,
  };
}

async function login(page: Page): Promise<string> {
  await page.goto("/login");
  const user = page.getByRole("textbox", { name: "用户名", exact: true });
  const pass = page.getByRole("textbox", { name: "密码", exact: true });
  await expect
    .poll(() =>
      user.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await user.pressSequentially(username);
  await pass.pressSequentially(password);
  await page.getByRole("button", { name: /登\s*录|正在登录/ }).click();
  await expect(page.getByRole("navigation", { name: "模块导航" })).toBeVisible();
  const token = await page.evaluate(() =>
    window.localStorage.getItem("synie:token"),
  );
  expect(token).toBeTruthy();
  return token!;
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: Record<string, unknown>,
  expected = 201,
): Promise<T> {
  const response = await request.post(path, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  const text = await response.text();
  expect(response.status(), `POST ${path}: ${response.status()} ${text}`).toBe(
    expected,
  );
  return JSON.parse(text) as T;
}

function cleanup(ids: string[]): void {
  const records =
    ids.length === 0
      ? "ARRAY[]::uuid[]"
      : `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`;
  postgres(`
    DELETE FROM sys_audit_log WHERE record_id=ANY(${records});
    DELETE FROM sal_delivery WHERE delivery_no LIKE '${prefix}%';
    DELETE FROM pur_receipt WHERE receipt_no LIKE '${prefix}%';
    DELETE FROM pur_outsourced_issue WHERE issue_no LIKE '${prefix}%';
    DELETE FROM pur_outsourced_receipt WHERE receipt_no LIKE '${prefix}%';
    DELETE FROM bas_account WHERE code LIKE '${prefix}%';
    DELETE FROM sal_customers WHERE code LIKE '${prefix}%';
    DELETE FROM pur_supplier WHERE code LIKE '${prefix}%';
    DELETE FROM bas_company WHERE code LIKE '${prefix}%';
    DELETE FROM bas_currency WHERE iso_code LIKE '${prefix}%';
  `);
}

test("标准与委外履约页面使用 Go REST 且业务 GraphQL 为零", async ({
  page,
  request,
}) => {
  let fixture: Fixture | null = null;
  const created: string[] = [];
  const graphql: string[] = [];
  const rest: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.endsWith("/graphql")) graphql.push(req.url());
    if (
      req.url().includes("/api/v1/sales/deliver") ||
      req.url().includes("/api/v1/purchase/receipt") ||
      req.url().includes("/api/v1/purchase/outsourced")
    ) {
      rest.push(`${req.method()} ${req.url()}`);
    }
  });

  try {
    fixture = createFixture();
    const token = await login(page);
    const common = {
      companyId: fixture.companyId,
      receiptDate: "2026-07-26",
      partyType: "SUPPLIER",
      partyId: fixture.supplierId,
      debitAccountId: fixture.debitAccountId,
      creditAccountId: fixture.creditAccountId,
    };
    const documents = [
      await post<{ id: string }>(
        request,
        "/api/v1/sales/deliveries",
        token,
        {
          deliveryNo: `${prefix}-SD`,
          deliveryDate: "2026-07-26",
          companyId: fixture.companyId,
          partyType: "CUSTOMER",
          partyId: fixture.customerId,
          debitAccountId: fixture.debitAccountId,
          creditAccountId: fixture.creditAccountId,
        },
      ),
      await post<{ id: string }>(
        request,
        "/api/v1/purchase/receipts",
        token,
        { ...common, receiptNo: `${prefix}-PR` },
      ),
      await post<{ id: string }>(
        request,
        "/api/v1/purchase/outsourced-issues",
        token,
        {
          issueNo: `${prefix}-OI`,
          issueDate: "2026-07-26",
          companyId: fixture.companyId,
          partyType: "SUPPLIER",
          partyId: fixture.supplierId,
        },
      ),
      await post<{ id: string }>(
        request,
        "/api/v1/purchase/outsourced-receipts",
        token,
        { ...common, receiptNo: `${prefix}-OR` },
      ),
    ];
    created.push(...documents.map((document) => document.id));

    for (const [path, resource, number] of [
      ["/scm/sales-deliveries/deliveries", "salDeliveries", `${prefix}-SD`],
      ["/scm/purchase-receipts/receipts", "purReceipts", `${prefix}-PR`],
      ["/scm/outsourced-issues/issues", "purOutsourcedIssues", `${prefix}-OI`],
      [
        "/scm/outsourced-receipts/receipts",
        "purOutsourcedReceipts",
        `${prefix}-OR`,
      ],
    ] as const) {
      await page.goto(path);
      await expect(
        page.getByRole("grid", { name: `${resource} 数据表格` }),
      ).toBeVisible();
      await expect(page.getByText(number, { exact: true })).toBeVisible();
    }

    expect(graphql, "履约消费面不得发业务 GraphQL").toEqual([]);
    expect(rest.length).toBeGreaterThanOrEqual(4);
  } finally {
    if (fixture) cleanup(created);
  }
});
