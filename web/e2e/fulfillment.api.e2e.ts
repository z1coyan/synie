import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { loginViaUI } from "./fixtures/session";

test.setTimeout(90_000);

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

async function openDeliveryEdit(
  page: Page,
  deliveryNo: string,
): Promise<Locator> {
  await page.goto("/sales/deliveries/deliveries");
  const grid = page.getByRole("grid", { name: "salDeliveries 数据表格" });
  await expect(grid).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索" }).fill(deliveryNo);
  const row = grid.getByRole("row").filter({ hasText: deliveryNo });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "编辑销售发货单" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("备注", { exact: true })).toBeVisible();
  return drawer;
}

async function chooseDrawerOption(
  page: Page,
  drawer: Locator,
  label: string,
  optionText: string,
): Promise<void> {
  const remotePlaceholder: Record<string, string> = {
    公司: "请选择…",
    对手: "选择客户…",
    "借方科目(未开票应收)": "选择未开票应收科目…",
    贷方科目: "选择贷方科目(收入/待转等)…",
  };
  const trigger =
    label in remotePlaceholder
      ? drawer
          .getByRole("group")
          .filter({ hasText: remotePlaceholder[label] })
          .first()
      : drawer.getByRole("button", {
          name: new RegExp(`^请选择.*${label}`),
        });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const option = page.getByRole("option").filter({ hasText: optionText }).first();
  await expect(option).toBeVisible();
  await option.click();
}

function deliveryDraftResponse(
  fixture: Fixture,
  id: string,
  deliveryNo: string,
  remarks: string,
): Record<string, unknown> {
  return {
    id,
    deliveryNo,
    deliveryDate: "2026-07-26",
    postingDate: null,
    companyId: fixture.companyId,
    partyType: "CUSTOMER",
    partyId: fixture.customerId,
    remarks,
    warehouseId: null,
    debitAccountId: fixture.debitAccountId,
    creditAccountId: fixture.creditAccountId,
    status: "DRAFT",
    auditedAt: null,
    auditedById: null,
    items: [],
    packBoxes: [],
  };
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
}) => {
  // page.request 与浏览器同 context,自动携带会话 cookie(request fixture 不共享 cookie)
  const request = page.request;
  let fixture: Fixture | null = null;
  const created: string[] = [];
  const graphql: string[] = [];
  const rest: string[] = [];
  const deliveryWorkflow: string[] = [];
  const childWrites: string[] = [];
  page.on("request", (req) => {
    const pathname = new URL(req.url()).pathname;
    const method = req.method();
    if (pathname.endsWith("/graphql")) graphql.push(req.url());
    if (
      req.url().includes("/api/v1/sales/deliver") ||
      req.url().includes("/api/v1/purchase/receipt") ||
      req.url().includes("/api/v1/purchase/outsourced")
    ) {
      rest.push(`${req.method()} ${req.url()}`);
    }
    if (
      (method === "POST" && pathname === "/api/v1/sales/deliveries") ||
      (method === "PUT" &&
        /^\/api\/v1\/sales\/deliveries\/[^/]+$/.test(pathname)) ||
      (method === "POST" &&
        /^\/api\/v1\/sales\/deliveries\/[^/]+\/audit$/.test(pathname))
    ) {
      deliveryWorkflow.push(`${method} ${pathname}`);
    }
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      /^\/api\/v1\/sales\/(?:delivery-items|delivery-pack-boxes|delivery-pack-lines)(?:\/[^/]+)?$/.test(
        pathname,
      ) &&
      !pathname.endsWith("/query")
    ) {
      childWrites.push(`${method} ${pathname}`);
    }
  });

  try {
    fixture = createFixture();
    await loginViaUI(page);
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
        {
          deliveryNo: `${prefix}-SD`,
          deliveryDate: "2026-07-26",
          companyId: fixture.companyId,
          partyType: "CUSTOMER",
          partyId: fixture.customerId,
          debitAccountId: fixture.debitAccountId,
          creditAccountId: fixture.creditAccountId,
          items: [],
          packBoxes: [],
        },
      ),
      await post<{ id: string }>(
        request,
        "/api/v1/purchase/receipts",
        { ...common, receiptNo: `${prefix}-PR` },
      ),
      await post<{ id: string }>(
        request,
        "/api/v1/purchase/outsourced-issues",
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
        { ...common, receiptNo: `${prefix}-OR` },
      ),
    ];
    created.push(...documents.map((document) => document.id));

    for (const [path, resource, number] of [
      ["/sales/deliveries/deliveries", "salDeliveries", `${prefix}-SD`],
      ["/purchase/receipts/receipts", "purReceipts", `${prefix}-PR`],
      ["/purchase/outsourced-issues/issues", "purOutsourcedIssues", `${prefix}-OI`],
      [
        "/purchase/outsourced-receipts/receipts",
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

    const salesDelivery = documents[0]!;
    const deliveryNo = `${prefix}-SD`;
    const deliveryPath = `/api/v1/sales/deliveries/${salesDelivery.id}`;
    const replaceRoute = `**${deliveryPath}`;
    const auditPath = `${deliveryPath}/audit`;
    const auditRoute = `**${auditPath}`;

    await test.step("新建抽屉只发送一次整单创建", async () => {
      await page.goto("/sales/deliveries/deliveries");
      await expect(
        page.getByRole("grid", { name: "salDeliveries 数据表格" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "新增", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "新增销售发货单" });
      await expect(drawer).toBeVisible();

      await chooseDrawerOption(
        page,
        drawer,
        "公司",
        `${prefix}验收公司`,
      );
      await chooseDrawerOption(page, drawer, "对手类型", "客户");
      await chooseDrawerOption(
        page,
        drawer,
        "对手",
        `${prefix}验收客户`,
      );
      await chooseDrawerOption(
        page,
        drawer,
        "借方科目(未开票应收)",
        `${prefix}未开票应收`,
      );
      await chooseDrawerOption(
        page,
        drawer,
        "贷方科目",
        `${prefix}未开票应付`,
      );

      const createdId = crypto.randomUUID();
      const createBodies: Record<string, unknown>[] = [];
      await page.route("**/api/v1/sales/deliveries", async (route) => {
        const request = route.request();
        if (
          request.method() !== "POST" ||
          new URL(request.url()).pathname !== "/api/v1/sales/deliveries"
        ) {
          await route.fallback();
          return;
        }
        createBodies.push(request.postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(
            deliveryDraftResponse(
              fixture!,
              createdId,
              `${prefix}-UI-CREATE`,
              "",
            ),
          ),
        });
      });

      const workflowStart = deliveryWorkflow.length;
      const childStart = childWrites.length;
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/sales/deliveries",
      );
      await drawer.getByRole("button", { name: "保存", exact: true }).click();
      await createResponse;
      await expect(drawer).toBeHidden();

      expect(deliveryWorkflow.slice(workflowStart)).toEqual([
        "POST /api/v1/sales/deliveries",
      ]);
      expect(childWrites.slice(childStart)).toEqual([]);
      expect(createBodies).toHaveLength(1);
      expect(createBodies[0]).toMatchObject({
        companyId: fixture.companyId,
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        debitAccountId: fixture.debitAccountId,
        creditAccountId: fixture.creditAccountId,
        items: [],
        packBoxes: [],
      });
      await page.unroute("**/api/v1/sales/deliveries");
    });

    await test.step("保存只发送一次整单替换且不写子资源", async () => {
      const drawer = await openDeliveryEdit(page, deliveryNo);
      const remarks = "整单保存浏览器验收";
      const bodies: Record<string, unknown>[] = [];
      await page.route(replaceRoute, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.fallback();
          return;
        }
        bodies.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            deliveryDraftResponse(
              fixture!,
              salesDelivery.id,
              deliveryNo,
              remarks,
            ),
          ),
        });
      });

      const workflowStart = deliveryWorkflow.length;
      const childStart = childWrites.length;
      await drawer.getByLabel("备注", { exact: true }).fill(remarks);
      const replaceResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === deliveryPath,
      );
      await drawer
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await replaceResponse;
      await expect(drawer).toBeHidden();

      expect(deliveryWorkflow.slice(workflowStart)).toEqual([
        `PUT ${deliveryPath}`,
      ]);
      expect(childWrites.slice(childStart)).toEqual([]);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        remarks,
        items: [],
        packBoxes: [],
      });
      await page.unroute(replaceRoute);
    });

    await test.step("整单保存失败时不发送审核请求", async () => {
      const drawer = await openDeliveryEdit(page, deliveryNo);
      const remarks = "保存失败仍保留";
      let interceptedAudit = 0;
      await page.route(replaceRoute, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "validation",
              message: "整单保存验收失败",
              fields: { "header.remarks": ["整单校验失败"] },
            },
          }),
        });
      });
      await page.route(auditRoute, async (route) => {
        interceptedAudit += 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "internal", message: "不应发送审核请求" },
          }),
        });
      });

      const workflowStart = deliveryWorkflow.length;
      const childStart = childWrites.length;
      await drawer.getByLabel("备注", { exact: true }).fill(remarks);
      const replaceResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === deliveryPath,
      );
      await drawer
        .getByRole("button", { name: "保存并审核", exact: true })
        .click();
      await replaceResponse;
      await expect(
        drawer.getByRole("button", { name: "保存并审核", exact: true }),
      ).toBeEnabled();

      await expect(drawer).toBeVisible();
      await expect(drawer.getByLabel("备注", { exact: true })).toHaveValue(
        remarks,
      );
      await expect(drawer.getByRole("alert")).toContainText("整单校验失败");
      expect(interceptedAudit).toBe(0);
      expect(deliveryWorkflow.slice(workflowStart)).toEqual([
        `PUT ${deliveryPath}`,
      ]);
      expect(childWrites.slice(childStart)).toEqual([]);

      await drawer
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(drawer).toBeHidden();
      await page.unroute(replaceRoute);
      await page.unroute(auditRoute);
    });

    await test.step("审核失败时保留已保存草稿抽屉", async () => {
      const drawer = await openDeliveryEdit(page, deliveryNo);
      const remarks = "审核失败仍保留";
      await page.route(replaceRoute, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            deliveryDraftResponse(
              fixture!,
              salesDelivery.id,
              deliveryNo,
              remarks,
            ),
          ),
        });
      });
      await page.route(auditRoute, async (route) => {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "validation", message: "审核验收失败" },
          }),
        });
      });

      const workflowStart = deliveryWorkflow.length;
      const childStart = childWrites.length;
      await drawer.getByLabel("备注", { exact: true }).fill(remarks);
      const replaceResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === deliveryPath,
      );
      const auditResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === auditPath,
      );
      await drawer
        .getByRole("button", { name: "保存并审核", exact: true })
        .click();
      await replaceResponse;
      await auditResponse;
      await expect(
        drawer.getByRole("button", { name: "保存并审核", exact: true }),
      ).toBeEnabled();

      await expect(drawer).toBeVisible();
      await expect(drawer.getByLabel("备注", { exact: true })).toHaveValue(
        remarks,
      );
      await expect(
        page.getByText("单据已保存,但审核失败", { exact: true }),
      ).toBeVisible();
      expect(deliveryWorkflow.slice(workflowStart)).toEqual([
        `PUT ${deliveryPath}`,
        `POST ${auditPath}`,
      ]);
      expect(childWrites.slice(childStart)).toEqual([]);

      await drawer
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(drawer).toBeHidden();
      await page.unroute(replaceRoute);
      await page.unroute(auditRoute);
    });

    expect(graphql, "履约消费面不得发业务 GraphQL").toEqual([]);
    expect(rest.length).toBeGreaterThanOrEqual(4);
  } finally {
    if (fixture) cleanup(created);
  }
});
