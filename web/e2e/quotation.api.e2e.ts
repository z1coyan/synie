import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "admin123";
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EQT${suffix}`;

type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  unitId: string;
  materialIds: [string, string];
};

type Created = {
  salesQuotationId: string | null;
  purchaseQuotationId: string | null;
  itemIds: string[];
  tierIds: string[];
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
      SELECT '${prefix}CO','${prefix}验收公司','${prefix}CO',id
      FROM currency
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
    unit AS (
      INSERT INTO bas_unit(unit_type,is_base,name,symbol,ratio)
      VALUES ('${prefix}TYPE',false,'${prefix}验收单位','${prefix}U',1)
      RETURNING id
    ),
    category AS (
      INSERT INTO inv_material_category(code,name,is_leaf,active)
      VALUES ('${prefix}CAT','${prefix}验收分类',true,true)
      RETURNING id
    ),
    material_a AS (
      INSERT INTO inv_material(
        code,name,spec,active,category_id,default_unit_id,
        is_customer_material,customer_id
      )
      SELECT
        '${prefix}M1','${prefix}物料一','规格一',true,
        category.id,unit.id,false,NULL
      FROM category,unit
      RETURNING id
    ),
    material_b AS (
      INSERT INTO inv_material(
        code,name,spec,active,category_id,default_unit_id,
        is_customer_material,customer_id
      )
      SELECT
        '${prefix}M2','${prefix}物料二','规格二',true,
        category.id,unit.id,false,NULL
      FROM category,unit
      RETURNING id
    )
    SELECT
      currency.id::text,
      company.id::text,
      customer.id::text,
      supplier.id::text,
      unit.id::text,
      material_a.id::text,
      material_b.id::text
    FROM currency,company,customer,supplier,unit,material_a,material_b;
  `);
  const [
    currencyId,
    companyId,
    customerId,
    supplierId,
    unitId,
    materialA,
    materialB,
  ] = raw.split("|");
  expect(
    currencyId &&
      companyId &&
      customerId &&
      supplierId &&
      unitId &&
      materialA &&
      materialB,
    "浏览器报价验收夹具创建失败",
  ).toBeTruthy();
  return {
    currencyId: currencyId!,
    companyId: companyId!,
    customerId: customerId!,
    supplierId: supplierId!,
    unitId: unitId!,
    materialIds: [materialA!, materialB!],
  };
}

async function login(page: Page): Promise<string> {
  await page.goto("/login");
  const usernameInput = page.getByRole("textbox", {
    name: "用户名",
    exact: true,
  });
  const passwordInput = page.getByRole("textbox", {
    name: "密码",
    exact: true,
  });
  await expect
    .poll(() =>
      usernameInput.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await usernameInput.pressSequentially(username);
  await passwordInput.pressSequentially(password);
  await page.getByRole("button", { name: /登\s*录|正在登录/ }).click();
  await expect(
    page.getByRole("navigation", { name: "模块导航" }),
  ).toBeVisible();
  const token = await page.evaluate(() =>
    window.localStorage.getItem("synie:token"),
  );
  expect(token).toBeTruthy();
  return token!;
}

async function apiJSON<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch",
  path: string,
  token: string,
  data?: Record<string, unknown>,
  expected = 200,
): Promise<T> {
  const response = await request[method](path, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  expect(
    response.status(),
    `${method.toUpperCase()} ${path}: ${response.status()} ${text}`,
  ).toBe(expected);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

function uuidList(ids: string[]): string {
  return ids.length === 0
    ? "ARRAY[]::uuid[]"
    : `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`;
}

function cleanup(created: Created): void {
  const recordIds = [
    created.salesQuotationId,
    created.purchaseQuotationId,
    ...created.itemIds,
    ...created.tierIds,
  ].filter((id): id is string => id !== null);
  postgres(`
    DELETE FROM sys_audit_log WHERE record_id=ANY(${uuidList(recordIds)});
    DELETE FROM sal_quotation WHERE quotation_no LIKE '${prefix}%';
    DELETE FROM pur_quotation WHERE quotation_no LIKE '${prefix}%';
    DELETE FROM inv_material WHERE code LIKE '${prefix}%';
    DELETE FROM inv_material_category WHERE code LIKE '${prefix}%';
    DELETE FROM bas_unit WHERE symbol LIKE '${prefix}%';
    DELETE FROM sal_customers WHERE code LIKE '${prefix}%';
    DELETE FROM pur_supplier WHERE code LIKE '${prefix}%';
    DELETE FROM bas_company WHERE code LIKE '${prefix}%';
    DELETE FROM bas_currency WHERE iso_code LIKE '${prefix}%';
  `);
  const residue = postgres(`
    SELECT
      (SELECT count(*) FROM sal_quotation WHERE quotation_no LIKE '${prefix}%'),
      (SELECT count(*) FROM pur_quotation WHERE quotation_no LIKE '${prefix}%'),
      (SELECT count(*) FROM sal_quotation_item WHERE id=ANY(${uuidList(created.itemIds)})),
      (SELECT count(*) FROM pur_quotation_item WHERE id=ANY(${uuidList(created.itemIds)})),
      (SELECT count(*) FROM sal_quotation_tier WHERE id=ANY(${uuidList(created.tierIds)})),
      (SELECT count(*) FROM pur_quotation_tier WHERE id=ANY(${uuidList(created.tierIds)})),
      (SELECT count(*) FROM inv_material WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM inv_material_category WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_unit WHERE symbol LIKE '${prefix}%'),
      (SELECT count(*) FROM sal_customers WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM pur_supplier WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_company WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_currency WHERE iso_code LIKE '${prefix}%'),
      (SELECT count(*) FROM sys_audit_log WHERE record_id=ANY(${uuidList(recordIds)}));
  `);
  expect(residue, "Chromium 报价验收夹具与审计必须精确归零").toBe(
    "0|0|0|0|0|0|0|0|0|0|0|0|0|0",
  );
}

async function quotationRow(page: Page, quotationNo: string) {
  const search = page.getByRole("searchbox", { name: "搜索" });
  await search.fill(quotationNo);
  const row = page.getByRole("row").filter({ hasText: quotationNo });
  await expect(row).toBeVisible();
  return row;
}

async function auditFromGrid(
  page: Page,
  quotationNo: string,
  resourceLabel: string,
  auditPath: string,
) {
  const row = await quotationRow(page, quotationNo);
  await expect(row).toContainText("草稿");
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "审核", exact: true }).click();
  const dialog = page.getByRole("alertdialog", {
    name: `审核${resourceLabel}`,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("row")).toHaveCount(3);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === auditPath,
  );
  await dialog.getByRole("button", { name: "确认审核" }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByText(`${resourceLabel}已审核`)).toBeVisible();
}

test.setTimeout(240_000);

test("销售/采购报价以 Go REST 完成混合定价、审核、过期、候选与作废", async ({
  page,
  request,
}) => {
  const created: Created = {
    salesQuotationId: null,
    purchaseQuotationId: null,
    itemIds: [],
    tierIds: [],
  };
  const graphqlRequests: string[] = [];
  const quotationRequests: string[] = [];
  page.on("request", (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname;
    if (pathname === "/graphql") graphqlRequests.push(outgoing.postData() ?? "");
    if (
      /^\/api\/v1\/(sales|purchase)\/quotation/.test(pathname) ||
      /^\/api\/v1\/meta\/resources\/(sal|pur)Quotation/.test(pathname)
    ) {
      quotationRequests.push(`${outgoing.method()} ${pathname}`);
    }
  });

  const salesNo = `${prefix}-SAL`;
  const purchaseNo = `${prefix}-PUR`;
  try {
    const fixture = createFixture();
    const token = await login(page);
    const sideInputs = [
      {
        side: "sales",
        quotationNo: salesNo,
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        quotationDate: "2026-07-01",
        validUntil: "2026-07-02",
      },
      {
        side: "purchase",
        quotationNo: purchaseNo,
        partyType: "SUPPLIER",
        partyId: fixture.supplierId,
        quotationDate: "2026-07-01",
        validUntil: "2026-12-31",
      },
    ] as const;

    for (const input of sideInputs) {
      const quotation = await apiJSON<{ id: string; status: string }>(
        request,
        "post",
        `/api/v1/${input.side}/quotations`,
        token,
        {
          quotationNo: input.quotationNo,
          quotationDate: input.quotationDate,
          validUntil: input.validUntil,
          partyType: input.partyType,
          partyId: input.partyId,
          companyId: fixture.companyId,
          currencyId: fixture.currencyId,
          terms: `${prefix} Chromium`,
        },
        201,
      );
      expect(quotation.status).toBe("DRAFT");
      if (input.side === "sales") created.salesQuotationId = quotation.id;
      else created.purchaseQuotationId = quotation.id;

      const fixed = await apiJSON<{ id: string; price: string }>(
        request,
        "post",
        `/api/v1/${input.side}/quotation-items`,
        token,
        {
          quotationId: quotation.id,
          idx: 1,
          materialId: fixture.materialIds[0],
          unitId: fixture.unitId,
          pricingMode: "FIXED",
          price: "12.50",
          taxRate: "0.13",
        },
        201,
      );
      expect(fixed.price).toBe("12.5");
      created.itemIds.push(fixed.id);

      const tiered = await apiJSON<{ id: string; price: null }>(
        request,
        "post",
        `/api/v1/${input.side}/quotation-items`,
        token,
        {
          quotationId: quotation.id,
          idx: 2,
          materialId: fixture.materialIds[1],
          unitId: fixture.unitId,
          pricingMode: "QTY_TIERED",
          price: null,
          taxRate: "0.13",
        },
        201,
      );
      expect(tiered.price).toBeNull();
      created.itemIds.push(tiered.id);

      for (const tierInput of [
        { minQty: "10", price: "11.00" },
        { minQty: "100", price: "9.50" },
      ]) {
        const tier = await apiJSON<{ id: string }>(
          request,
          "post",
          `/api/v1/${input.side}/quotation-tiers`,
          token,
          { itemId: tiered.id, ...tierInput },
          201,
        );
        created.tierIds.push(tier.id);
      }
    }

    await page.goto("/scm/quotations/quotations");
    await expect(
      page.getByRole("heading", { name: "销售报价", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "salQuotations 数据表格" }),
    ).toBeVisible();
    await auditFromGrid(
      page,
      salesNo,
      "销售报价单",
      `/api/v1/sales/quotations/${created.salesQuotationId}/audit`,
    );
    await expect(await quotationRow(page, salesNo)).toContainText("已过期");

    const salesCandidates = await apiJSON<{
      count: number;
      results: Array<{ quotationId: string; tierCount: number }>;
    }>(
      request,
      "post",
      "/api/v1/sales/quotation-items/query",
      token,
      {
        limit: 20,
        offset: 0,
        filter: {
          quotationStatus: { kind: "enum", op: "in", values: ["AUDITED"] },
          companyId: {
            kind: "fk",
            op: "in",
            values: [fixture.companyId],
            labels: [],
          },
          partyType: { kind: "enum", op: "in", values: ["CUSTOMER"] },
          partyId: {
            kind: "polyFk",
            op: "in",
            values: [fixture.customerId],
            labels: [],
            variant: "CUSTOMER",
          },
          currencyId: {
            kind: "fk",
            op: "in",
            values: [fixture.currencyId],
            labels: [],
          },
          quotationDate: {
            kind: "date",
            op: "between",
            lte: "2026-07-02",
          },
          validUntil: {
            kind: "date",
            op: "between",
            gte: "2026-07-02",
          },
        },
      },
    );
    expect(salesCandidates.count).toBe(2);
    expect(
      salesCandidates.results.every(
        (item) => item.quotationId === created.salesQuotationId,
      ),
    ).toBe(true);
    expect(salesCandidates.results.map((item) => item.tierCount)).toEqual([
      0, 2,
    ]);

    await page.goto("/scm/purchase-quotations/quotations");
    await expect(
      page.getByRole("heading", { name: "采购报价", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "purQuotations 数据表格" }),
    ).toBeVisible();
    await auditFromGrid(
      page,
      purchaseNo,
      "采购报价单",
      `/api/v1/purchase/quotations/${created.purchaseQuotationId}/audit`,
    );
    let purchaseRow = await quotationRow(page, purchaseNo);
    await expect(purchaseRow).toContainText("已审核");
    await purchaseRow.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "作废", exact: true }).click();
    const voidDialog = page.getByRole("alertdialog", { name: "确认作废" });
    await expect(voidDialog).toBeVisible();
    const voidResponse = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname ===
          `/api/v1/purchase/quotations/${created.purchaseQuotationId}/void`,
    );
    await voidDialog.getByRole("button", { name: "确认", exact: true }).click();
    expect((await voidResponse).ok()).toBeTruthy();
    purchaseRow = await quotationRow(page, purchaseNo);
    await expect(purchaseRow).toContainText("已作废");

    expect(graphqlRequests, "两个报价消费面不得回退 /graphql").toEqual([]);
    expect(
      quotationRequests.some((requestLine) =>
        requestLine.includes("/sales/quotations"),
      ),
    ).toBe(true);
    expect(
      quotationRequests.some((requestLine) =>
        requestLine.includes("/purchase/quotations"),
      ),
    ).toBe(true);
  } finally {
    cleanup(created);
  }
});
