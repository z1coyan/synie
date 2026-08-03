import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { loginViaUI } from "./fixtures/session";

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2ERC${suffix}`;

type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  salesDebitId: string;
  salesCreditId: string;
  purchaseDebitId: string;
  purchaseCreditId: string;
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
    sales_debit AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id
      )
      SELECT '${prefix}SD','${prefix}销售借方','debit',false,true,company.id,currency.id
      FROM company,currency
      RETURNING id
    ),
    sales_credit AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT '${prefix}SC','${prefix}未开票应收','credit',false,true,
             company.id,currency.id,'unbilled_receivable'
      FROM company,currency
      RETURNING id
    ),
    purchase_debit AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT '${prefix}PD','${prefix}未开票应付','debit',false,true,
             company.id,currency.id,'unbilled_payable'
      FROM company,currency
      RETURNING id
    ),
    purchase_credit AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id
      )
      SELECT '${prefix}PC','${prefix}采购贷方','credit',false,true,company.id,currency.id
      FROM company,currency
      RETURNING id
    )
    SELECT currency.id::text,company.id::text,customer.id::text,supplier.id::text,
           sales_debit.id::text,sales_credit.id::text,
           purchase_debit.id::text,purchase_credit.id::text
    FROM currency,company,customer,supplier,sales_debit,sales_credit,
         purchase_debit,purchase_credit;
  `);
  const [
    currencyId,
    companyId,
    customerId,
    supplierId,
    salesDebitId,
    salesCreditId,
    purchaseDebitId,
    purchaseCreditId,
  ] = raw.split("|");
  expect(
    currencyId &&
      companyId &&
      customerId &&
      supplierId &&
      salesDebitId &&
      salesCreditId &&
      purchaseDebitId &&
      purchaseCreditId,
    "对账浏览器夹具创建失败",
  ).toBeTruthy();
  return {
    currencyId: currencyId!,
    companyId: companyId!,
    customerId: customerId!,
    supplierId: supplierId!,
    salesDebitId: salesDebitId!,
    salesCreditId: salesCreditId!,
    purchaseDebitId: purchaseDebitId!,
    purchaseCreditId: purchaseCreditId!,
  };
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
  expected = 201,
): Promise<T> {
  // 调用侧传 page.request:与浏览器同 context,自动携带会话 cookie
  const response = await request.post(path, { data });
  const text = await response.text();
  expect(response.status(), `POST ${path}: ${response.status()} ${text}`).toBe(
    expected,
  );
  return JSON.parse(text) as T;
}

async function openReconciliationDrawer(
  page: Page,
  path: string,
  resource: string,
  number: string,
  label: string,
  pageErrors: string[],
) {
  await page.goto(path);
  await expect(
    page.getByRole("grid", { name: `${resource} 数据表格` }),
    `页面运行时错误: ${pageErrors.join(" | ")}`,
  ).toBeVisible();
  const search = page.getByRole("searchbox", { name: "搜索" });
  await search.fill(number);
  const row = page.getByRole("row").filter({ hasText: number });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "查看", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: `${label}详情` });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(number, { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(drawer).toBeHidden();
}

async function chooseCompany(page: Page, companyName: string) {
  const company = page.getByText("选择公司…", { exact: true });
  await expect(company).toBeVisible();
  await company.click();
  const option = page
    .getByRole("option")
    .filter({ hasText: companyName })
    .first();
  await expect(option).toBeVisible();
  await option.click();
}

function cleanup(fixture: Fixture | null): void {
  if (!fixture) return;
  postgres(`
    DELETE FROM sys_todo WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM sys_audit_log WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM sal_reconciliation WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM pur_reconciliation WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM sal_company_account_default WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM bas_account WHERE company_id='${fixture.companyId}'::uuid;
    DELETE FROM sal_customers WHERE id='${fixture.customerId}'::uuid;
    DELETE FROM pur_supplier WHERE id='${fixture.supplierId}'::uuid;
    DELETE FROM bas_company WHERE id='${fixture.companyId}'::uuid;
    DELETE FROM bas_currency WHERE id='${fixture.currencyId}'::uuid;
  `);
}

test.setTimeout(120_000);

test("销售采购对账 Grid、Drawer 与默认科目设置全程使用 Go REST", async ({
  page,
}) => {
  // page.request 与浏览器同 context,自动携带会话 cookie(request fixture 不共享 cookie)
  const request = page.request;
  let fixture: Fixture | null = null;
  const graphql: string[] = [];
  const reconciliationREST: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path === "/graphql") {
      graphql.push(`${req.method()} ${path} ${req.postData() ?? ""}`);
    }
    if (
      path.startsWith("/api/v1/sales/reconciliation") ||
      path.startsWith("/api/v1/purchase/reconciliation") ||
      path.startsWith("/api/v1/sales/company-account-defaults") ||
      path === "/api/v1/settings/supply-chain"
    ) {
      reconciliationREST.push(`${req.method()} ${path}`);
    }
  });

  try {
    fixture = createFixture();
    await loginViaUI(page);
    const defaults = await post<{ id: string }>(
      request,
      "/api/v1/sales/company-account-defaults",
      {
        companyId: fixture.companyId,
        deliveryDebitAccountId: fixture.salesCreditId,
        deliveryCreditAccountId: fixture.salesDebitId,
        receiptDebitAccountId: fixture.purchaseCreditId,
        receiptCreditAccountId: fixture.purchaseDebitId,
      },
    );
    expect(defaults.id).toBeTruthy();

    const salesNo = `${prefix}-SR`;
    const purchaseNo = `${prefix}-PR`;
    const common = {
      reconciliationType: "REGULAR",
      companyId: fixture.companyId,
    };
    await post(request, "/api/v1/sales/reconciliations", {
      ...common,
      reconciliationNo: salesNo,
      partyType: "CUSTOMER",
      partyId: fixture.customerId,
      debitAccountId: fixture.salesDebitId,
      creditAccountId: fixture.salesCreditId,
    });
    await post(request, "/api/v1/purchase/reconciliations", {
      ...common,
      reconciliationNo: purchaseNo,
      partyType: "SUPPLIER",
      partyId: fixture.supplierId,
      debitAccountId: fixture.purchaseDebitId,
      creditAccountId: fixture.purchaseCreditId,
    });

    expect(pageErrors, "对账页面加载前不应有运行时错误").toEqual([]);
    await openReconciliationDrawer(
      page,
      "/sales/reconciliations/reconciliations",
      "salReconciliations",
      salesNo,
      "销售对账单",
      pageErrors,
    );
    await openReconciliationDrawer(
      page,
      "/purchase/reconciliations/reconciliations",
      "purReconciliations",
      purchaseNo,
      "采购对账单",
      pageErrors,
    );

    const companyName = `${prefix}验收公司`;
    await page.goto("/scm/settings/sales");
    await expect(
      page.getByRole("heading", { name: "供应链设置", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("销售发货默认科目", { exact: true }),
    ).toBeVisible();
    await chooseCompany(page, companyName);
    await expect(
      page.getByText(`${prefix}未开票应收`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`${prefix}销售借方`, { exact: true }),
    ).toBeVisible();

    await page.goto("/scm/settings/purchase");
    await expect(
      page.getByText("采购入库默认科目", { exact: true }),
    ).toBeVisible();
    await chooseCompany(page, companyName);
    await expect(
      page.getByText(`${prefix}采购贷方`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`${prefix}未开票应付`, { exact: true }),
    ).toBeVisible();

    expect(graphql, "对账与默认科目消费面不得发业务 GraphQL").toEqual([]);
    expect(
      reconciliationREST.some((entry) =>
        entry.includes("POST /api/v1/sales/reconciliations/query"),
      ),
    ).toBe(true);
    expect(
      reconciliationREST.some((entry) =>
        entry.includes("POST /api/v1/purchase/reconciliations/query"),
      ),
    ).toBe(true);
    expect(
      reconciliationREST.some((entry) =>
        entry.includes("/api/v1/sales/company-account-defaults/by-company/"),
      ),
    ).toBe(true);
  } finally {
    cleanup(fixture);
  }
});
