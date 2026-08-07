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
const prefix = `E2EOR${suffix}`;

type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  unitId: string;
  materialId: string;
  byproductId: string;
  bomId: string;
  demandId: string;
  demandLineId: string;
  demandUserId: string;
};

type Created = {
  salesOrderId: string | null;
  purchaseOrderId: string | null;
  quotationIds: string[];
  quotationItemIds: string[];
  tierIds: string[];
  orderItemIds: string[];
  materialLineIds: string[];
  byproductLineIds: string[];
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
      VALUES ('${prefix}TYPE',true,'${prefix}验收单位','${prefix}U',1)
      RETURNING id
    ),
    category AS (
      INSERT INTO inv_material_category(code,name,is_leaf,active)
      VALUES ('${prefix}CAT','${prefix}验收分类',true,true)
      RETURNING id
    ),
    material AS (
      INSERT INTO inv_material(code,name,spec,active,category_id,default_unit_id,is_customer_material)
      SELECT '${prefix}M1','${prefix}成品','规格一',true,category.id,unit.id,false
      FROM category,unit
      RETURNING id
    ),
    byproduct AS (
      INSERT INTO inv_material(code,name,spec,active,category_id,default_unit_id,is_customer_material)
      SELECT '${prefix}M2','${prefix}副产物','规格二',true,category.id,unit.id,false
      FROM category,unit
      RETURNING id
    ),
    demand_user AS (
      INSERT INTO sys_user(username,name,hashed_password,super_admin,all_companies)
      VALUES ('${prefix.toLowerCase()}demand','${prefix}需求用户','test',false,false)
      RETURNING id
    ),
    bom AS (
      INSERT INTO mfg_bom(code,plan_name,material_id)
      SELECT '${prefix}BOM','${prefix}方案',id FROM material
      RETURNING id
    ),
    component AS (
      INSERT INTO mfg_bom_component(bom_id,material_id,unit_id,quantity,loss_rate,note)
      SELECT bom.id,material.id,unit.id,1,0.1,'发料'
      FROM bom,material,unit
    ),
    bom_byproduct AS (
      INSERT INTO mfg_bom_byproduct(bom_id,material_id,unit_id,quantity,note)
      SELECT bom.id,byproduct.id,unit.id,0.2,'副产物'
      FROM bom,byproduct,unit
    ),
    demand AS (
      INSERT INTO mfg_demand(demand_no,demand_date,assign_type,status,company_id,created_by_id)
      SELECT '${prefix}D',CURRENT_DATE,'purchase','confirmed',company.id,demand_user.id
      FROM company,demand_user
      RETURNING id
    ),
    demand_line AS (
      INSERT INTO mfg_demand_item(
        idx,qty,base_qty,need_date,fulfillment_method,status,
        material_code,material_name,unit_name,demand_id,company_id,
        material_id,unit_id,ordered_qty,received_qty
      )
      SELECT
        1,20,20,CURRENT_DATE,'outsource','pending',
        '${prefix}M1','${prefix}成品','${prefix}验收单位',
        demand.id,company.id,material.id,unit.id,0,0
      FROM demand,company,material,unit
      RETURNING id
    )
    SELECT
      currency.id::text,
      company.id::text,
      customer.id::text,
      supplier.id::text,
      unit.id::text,
      material.id::text,
      byproduct.id::text,
      bom.id::text,
      demand.id::text,
      demand_line.id::text,
      demand_user.id::text
    FROM currency,company,customer,supplier,unit,material,byproduct,bom,demand,demand_line,demand_user;
  `);
  const values = raw.split("|");
  expect(values).toHaveLength(11);
  return {
    currencyId: values[0]!,
    companyId: values[1]!,
    customerId: values[2]!,
    supplierId: values[3]!,
    unitId: values[4]!,
    materialId: values[5]!,
    byproductId: values[6]!,
    bomId: values[7]!,
    demandId: values[8]!,
    demandLineId: values[9]!,
    demandUserId: values[10]!,
  };
}

async function apiJSON<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch",
  path: string,
  data?: Record<string, unknown>,
  expected = 200,
): Promise<T> {
  // 调用侧传 page.request:与浏览器同 context,自动携带会话 cookie
  const response = await request[method](path, {
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

function cleanup(fixture: Fixture, created: Created): void {
  const recordIds = [
    created.salesOrderId,
    created.purchaseOrderId,
    ...created.quotationIds,
    ...created.quotationItemIds,
    ...created.tierIds,
    ...created.orderItemIds,
    ...created.materialLineIds,
    ...created.byproductLineIds,
  ].filter((id): id is string => id !== null);
  // 单据编号由系统按规则生成(不再带 prefix),头表一律按 id 清场
  const salesOrderIds = uuidList(
    created.salesOrderId ? [created.salesOrderId] : [],
  );
  const purchaseOrderIds = uuidList(
    created.purchaseOrderId ? [created.purchaseOrderId] : [],
  );
  const quotationIds = uuidList(created.quotationIds);
  postgres(`
    DELETE FROM sys_audit_log WHERE record_id=ANY(${uuidList(recordIds)});
    DELETE FROM sal_order WHERE id=ANY(${salesOrderIds});
    DELETE FROM pur_order WHERE id=ANY(${purchaseOrderIds});
    DELETE FROM sal_quotation WHERE id=ANY(${quotationIds});
    DELETE FROM pur_quotation WHERE id=ANY(${quotationIds});
    DELETE FROM mfg_demand WHERE id='${fixture.demandId}'::uuid;
    DELETE FROM sys_user WHERE id='${fixture.demandUserId}'::uuid;
    DELETE FROM mfg_bom WHERE id='${fixture.bomId}'::uuid;
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
      (SELECT count(*) FROM sal_order WHERE id=ANY(${salesOrderIds})),
      (SELECT count(*) FROM pur_order WHERE id=ANY(${purchaseOrderIds})),
      (SELECT count(*) FROM sal_quotation WHERE id=ANY(${quotationIds})),
      (SELECT count(*) FROM pur_quotation WHERE id=ANY(${quotationIds})),
      (SELECT count(*) FROM mfg_demand WHERE id='${fixture.demandId}'::uuid),
      (SELECT count(*) FROM mfg_bom WHERE id='${fixture.bomId}'::uuid),
      (SELECT count(*) FROM inv_material WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM inv_material_category WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_unit WHERE symbol LIKE '${prefix}%'),
      (SELECT count(*) FROM sal_customers WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM pur_supplier WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_company WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_currency WHERE iso_code LIKE '${prefix}%'),
      (SELECT count(*) FROM sys_audit_log WHERE record_id=ANY(${uuidList(recordIds)}));
  `);
  expect(residue, "Chromium 订单验收夹具、业务记录与审计必须精确归零").toBe(
    "0|0|0|0|0|0|0|0|0|0|0|0|0|0",
  );
}

async function orderRow(page: Page, orderNo: string) {
  const search = page.getByRole("searchbox", { name: "搜索" });
  await search.fill(orderNo);
  const row = page.getByRole("row").filter({ hasText: orderNo });
  await expect(row).toBeVisible();
  return row;
}

async function auditFromGrid(
  page: Page,
  orderNo: string,
  label: string,
  path: string,
) {
  const row = await orderRow(page, orderNo);
  await expect(row).toContainText("草稿");
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "审核", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `审核${label}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("row")).toHaveCount(2);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === path,
  );
  await dialog.getByRole("button", { name: "确认审核" }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page.getByText(`${label}已审核`)).toBeVisible();
}

async function statusAction(
  page: Page,
  orderNo: string,
  action: "关闭" | "作废",
  path: string,
) {
  const row = await orderRow(page, orderNo);
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `确认${action}` });
  await expect(dialog).toBeVisible();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === path,
  );
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  expect((await response).ok()).toBeTruthy();
}

test.setTimeout(240_000);

test("销售/采购订单以 Go REST 完成报价、BOM、需求、审核、关闭与作废", async ({
  page,
}) => {
  // page.request 与浏览器同 context,自动携带会话 cookie(request fixture 不共享 cookie)
  const request = page.request;
  const created: Created = {
    salesOrderId: null,
    purchaseOrderId: null,
    quotationIds: [],
    quotationItemIds: [],
    tierIds: [],
    orderItemIds: [],
    materialLineIds: [],
    byproductLineIds: [],
  };
  let fixture: Fixture | null = null;
  const targetGraphQL: string[] = [];
  const orderRequests: string[] = [];
  page.on("request", (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname;
    if (pathname === "/graphql") {
      const payload = outgoing.postData() ?? "";
      if (
        /(?:sal|pur)Order(?:s|Items|ItemMaterials|ItemByproducts)\s*\(/.test(
          payload,
        )
      ) {
        targetGraphQL.push(payload);
      }
    }
    if (
      /^\/api\/v1\/(sales|purchase)\/order/.test(pathname) ||
      /^\/api\/v1\/meta\/resources\/(sal|pur)Order/.test(pathname)
    ) {
      orderRequests.push(`${outgoing.method()} ${pathname}`);
    }
  });

  try {
    fixture = createFixture();
    await loginViaUI(page);
    const quoteInputs = [
      {
        side: "sales",
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        mode: "FIXED",
      },
      {
        side: "purchase",
        partyType: "SUPPLIER",
        partyId: fixture.supplierId,
        mode: "QTY_TIERED",
      },
    ] as const;
    const quoteItemBySide = new Map<string, string>();
    for (const quoteInput of quoteInputs) {
      // 报价编号由系统按规则生成,create 不再携带 quotationNo(手填即 400)
      const quotation = await apiJSON<{ id: string; quotationNo: string }>(
        request,
        "post",
        `/api/v1/${quoteInput.side}/quotations`,
        {
          quotationDate: "2026-07-01",
          validUntil: "2026-08-31",
          partyType: quoteInput.partyType,
          partyId: quoteInput.partyId,
          companyId: fixture.companyId,
          currencyId: fixture.currencyId,
        },
        201,
      );
      created.quotationIds.push(quotation.id);
      const quotationItem = await apiJSON<{ id: string; price: string | null }>(
        request,
        "post",
        `/api/v1/${quoteInput.side}/quotation-items`,
        {
          quotationId: quotation.id,
          idx: 1,
          materialId: fixture.materialId,
          unitId: fixture.unitId,
          pricingMode: quoteInput.mode,
          price: quoteInput.mode === "FIXED" ? "12.5" : null,
          taxRate: "0.13",
        },
        201,
      );
      created.quotationItemIds.push(quotationItem.id);
      quoteItemBySide.set(quoteInput.side, quotationItem.id);
      if (quoteInput.mode === "QTY_TIERED") {
        for (const [minQty, price] of [
          ["1", "9"],
          ["10", "8"],
        ]) {
          const tier = await apiJSON<{ id: string }>(
            request,
            "post",
            `/api/v1/${quoteInput.side}/quotation-tiers`,
            { itemId: quotationItem.id, minQty, price },
            201,
          );
          created.tierIds.push(tier.id);
        }
      }
      await apiJSON(
        request,
        "post",
        `/api/v1/${quoteInput.side}/quotations/${quotation.id}/audit`,
      );
    }

    // 订单编号由系统按规则生成:不传 orderNo,从响应读出供后续 UI 搜索/断言
    const sales = await apiJSON<{ id: string; orderNo: string }>(
      request,
      "post",
      "/api/v1/sales/orders",
      {
        orderDate: "2026-07-26",
        orderType: "REGULAR",
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        companyId: fixture.companyId,
      },
      201,
    );
    const salesNo = sales.orderNo;
    expect(salesNo, "系统应生成销售订单编号").toBeTruthy();
    created.salesOrderId = sales.id;
    const salesItem = await apiJSON<{
      id: string;
      price: string;
      amount: string;
      pricingMode: string;
    }>(
      request,
      "post",
      "/api/v1/sales/order-items",
      {
        orderId: sales.id,
        idx: 1,
        materialId: fixture.byproductId,
        unitId: fixture.unitId,
        qty: "20",
        quotationItemId: quoteItemBySide.get("sales"),
      },
      201,
    );
    created.orderItemIds.push(salesItem.id);
    expect(Number(salesItem.price)).toBe(12.5);
    expect(Number(salesItem.amount)).toBe(250);
    expect(salesItem.pricingMode).toBe("FIXED");

    const purchase = await apiJSON<{ id: string; orderNo: string }>(
      request,
      "post",
      "/api/v1/purchase/orders",
      {
        orderDate: "2026-07-26",
        orderType: "REGULAR",
        isOutsourced: true,
        partyType: "SUPPLIER",
        partyId: fixture.supplierId,
        companyId: fixture.companyId,
      },
      201,
    );
    const purchaseNo = purchase.orderNo;
    expect(purchaseNo, "系统应生成采购订单编号").toBeTruthy();
    created.purchaseOrderId = purchase.id;
    const purchaseItem = await apiJSON<{
      id: string;
      price: string;
      pricingMode: string;
      bomCode: string;
      demandNo: string;
    }>(
      request,
      "post",
      "/api/v1/purchase/order-items",
      {
        orderId: purchase.id,
        idx: 1,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        qty: "12",
        quotationItemId: quoteItemBySide.get("purchase"),
        bomId: fixture.bomId,
        demandLineId: fixture.demandLineId,
        demandDate: "2026-07-26",
      },
      201,
    );
    created.orderItemIds.push(purchaseItem.id);
    expect(Number(purchaseItem.price)).toBe(8);
    expect(purchaseItem.pricingMode).toBe("QTY_TIERED");
    expect(purchaseItem.bomCode).toBe(`${prefix}BOM`);
    expect(purchaseItem.demandNo).toBe(`${prefix}D`);

    const expansion = await apiJSON<{
      materials: Array<{ quantity: string }>;
      byproducts: Array<{ quantity: string }>;
    }>(
      request,
      "post",
      "/api/v1/purchase/order-bom/expand",
      { bomId: fixture.bomId, qty: "12" },
    );
    expect(Number(expansion.materials[0]!.quantity)).toBe(13.2);
    expect(Number(expansion.byproducts[0]!.quantity)).toBe(2.4);
    for (const [path, materialId, quantity, destination] of [
      [
        "/api/v1/purchase/order-item-materials",
        fixture.materialId,
        expansion.materials[0]!.quantity,
        created.materialLineIds,
      ],
      [
        "/api/v1/purchase/order-item-byproducts",
        fixture.byproductId,
        expansion.byproducts[0]!.quantity,
        created.byproductLineIds,
      ],
    ] as const) {
      const line = await apiJSON<{ id: string }>(
        request,
        "post",
        path,
        {
          orderItemId: purchaseItem.id,
          materialId,
          unitId: fixture.unitId,
          quantity,
        },
        201,
      );
      destination.push(line.id);
    }

    await page.goto("/sales/orders/orders");
    await expect(
      page.getByRole("grid", { name: "salOrders 数据表格" }),
    ).toBeVisible();
    await auditFromGrid(
      page,
      salesNo,
      "销售订单",
      `/api/v1/sales/orders/${sales.id}/audit`,
    );
    // 回归:发货抽屉「可发货订单条目池」过滤口径(计算字段 remainingBaseQty 参与过滤/排序)
    // 曾因 SQL 子查询未暴露 remaining_base_qty 列而 500
    const pool = await apiJSON<{
      count: number;
      results: Array<{ id: string; remainingBaseQty: string; currencyCode: string }>;
    }>(request, "post", "/api/v1/sales/order-items/query", {
      limit: 10,
      offset: 0,
      sort: { column: "orderDate", direction: "ascending" },
      filter: {
        orderStatus: { kind: "enum", values: ["AUDITED"] },
        companyId: {
          kind: "fk",
          op: "in",
          values: [fixture.companyId],
          labels: [],
        },
        partyType: { kind: "enum", values: ["CUSTOMER"] },
        partyId: {
          kind: "polyFk",
          op: "in",
          variant: "CUSTOMER",
          values: [fixture.customerId],
          labels: [],
        },
        remainingBaseQty: { kind: "number", op: "gt", value: "0" },
      },
    });
    expect(
      pool.results.some(
        (row) =>
          created.orderItemIds.includes(row.id) &&
          Number(row.remainingBaseQty) > 0 &&
          row.currencyCode.length > 0,
      ),
      "可发货订单条目池应包含已审核未发完的条目(remainingBaseQty 过滤/排序可用)",
    ).toBe(true);
    await statusAction(
      page,
      salesNo,
      "关闭",
      `/api/v1/sales/orders/${sales.id}/close`,
    );
    await expect(await orderRow(page, salesNo)).toContainText("已关闭");

    await page.goto("/purchase/orders/orders");
    await expect(
      page.getByRole("grid", { name: "purOrders 数据表格" }),
    ).toBeVisible();
    await auditFromGrid(
      page,
      purchaseNo,
      "采购订单",
      `/api/v1/purchase/orders/${purchase.id}/audit`,
    );
    expect(
      Number(
        postgres(
          `SELECT ordered_qty FROM mfg_demand_item WHERE id='${fixture.demandLineId}'::uuid`,
        ),
      ),
    ).toBe(12);
    await statusAction(
      page,
      purchaseNo,
      "作废",
      `/api/v1/purchase/orders/${purchase.id}/void`,
    );
    await expect(await orderRow(page, purchaseNo)).toContainText("已作废");
    expect(
      Number(
        postgres(
          `SELECT ordered_qty FROM mfg_demand_item WHERE id='${fixture.demandLineId}'::uuid`,
        ),
      ),
    ).toBe(0);

    expect(targetGraphQL, "订单消费面不得回退目标 GraphQL operation").toEqual([]);
    expect(
      orderRequests.some((line) => line.includes("/sales/orders")),
    ).toBe(true);
    expect(
      orderRequests.some((line) => line.includes("/purchase/orders")),
    ).toBe(true);
    expect(
      orderRequests.some((line) => line.includes("/purchase/order-items")),
    ).toBe(true);
  } finally {
    if (fixture) cleanup(fixture, created);
  }
});
