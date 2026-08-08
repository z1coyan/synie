import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { loginViaUI } from "./fixtures/session";

/**
 * 销售订单「从报价批量选择」验收(synie-source-picker 首个消费者):
 * 固定价 + 数量梯度两条报价条目一次性勾选纳入,弹窗内填数量,保存后后端权威定价
 * (固定价带出、梯度按数量套档);已纳入条目再从候选池消失(池剔除防重复)。
 */

const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EBQ${suffix}`;

type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  unitId: string;
  fixedMaterialId: string;
  tieredMaterialId: string;
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
    fixed_material AS (
      INSERT INTO inv_material(code,name,spec,active,category_id,default_unit_id,is_customer_material)
      SELECT '${prefix}M1','${prefix}固定价成品','规格一',true,category.id,unit.id,false
      FROM category,unit
      RETURNING id
    ),
    tiered_material AS (
      INSERT INTO inv_material(code,name,spec,active,category_id,default_unit_id,is_customer_material)
      SELECT '${prefix}M2','${prefix}梯度价成品','规格二',true,category.id,unit.id,false
      FROM category,unit
      RETURNING id
    )
    SELECT
      currency.id::text,
      company.id::text,
      customer.id::text,
      unit.id::text,
      fixed_material.id::text,
      tiered_material.id::text
    FROM currency,company,customer,unit,category,fixed_material,tiered_material;
  `);
  const values = raw.split("|");
  expect(values).toHaveLength(6);
  return {
    currencyId: values[0]!,
    companyId: values[1]!,
    customerId: values[2]!,
    unitId: values[3]!,
    fixedMaterialId: values[4]!,
    tieredMaterialId: values[5]!,
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

test.setTimeout(120_000);

test("销售订单批量勾选报价条目:弹窗填数量、套档定价与池剔除", async ({
  page,
}) => {
  const request = page.request;
  let fixture: Fixture | null = null;
  let orderId: string | null = null;
  let quotationId: string | null = null;

  try {
    fixture = createFixture();
    await loginViaUI(page);

    // 已审核报价:固定价条目(12.5) + 数量梯度条目(1→9,10→8)
    const quotation = await apiJSON<{ id: string }>(
      request,
      "post",
      "/api/v1/sales/quotations",
      {
        quotationDate: "2026-07-01",
        validUntil: "2026-08-31",
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        companyId: fixture.companyId,
        currencyId: fixture.currencyId,
      },
      201,
    );
    quotationId = quotation.id;
    const fixedItem = await apiJSON<{ id: string }>(
      request,
      "post",
      "/api/v1/sales/quotation-items",
      {
        quotationId,
        idx: 1,
        materialId: fixture.fixedMaterialId,
        unitId: fixture.unitId,
        pricingMode: "FIXED",
        price: "12.5",
        taxRate: "0.13",
      },
      201,
    );
    const tieredItem = await apiJSON<{ id: string }>(
      request,
      "post",
      "/api/v1/sales/quotation-items",
      {
        quotationId,
        idx: 2,
        materialId: fixture.tieredMaterialId,
        unitId: fixture.unitId,
        pricingMode: "QTY_TIERED",
        price: null,
        taxRate: "0.13",
      },
      201,
    );
    for (const [minQty, price] of [
      ["1", "9"],
      ["10", "8"],
    ]) {
      await apiJSON(
        request,
        "post",
        "/api/v1/sales/quotation-tiers",
        { itemId: tieredItem.id, minQty, price },
        201,
      );
    }
    await apiJSON(
      request,
      "post",
      `/api/v1/sales/quotations/${quotationId}/audit`,
    );

    // 空草稿订单:订单日期落在报价有效期内
    const order = await apiJSON<{ id: string; orderNo: string }>(
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
    orderId = order.id;

    // 深链直达编辑态抽屉(?record=&mode= 为 urlSync 契约)
    await page.goto(`/sales/orders/orders?record=${orderId}&mode=edit`);
    const drawer = page.getByRole("dialog", { name: "编辑销售订单" });
    await expect(drawer).toBeVisible();

    await drawer
      .getByRole("button", { name: "从报价批量选择", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "从报价批量选择" });
    await expect(picker).toBeVisible();

    const fixedRow = picker
      .getByRole("row")
      .filter({ hasText: `${prefix}M1` });
    const tieredRow = picker
      .getByRole("row")
      .filter({ hasText: `${prefix}M2` });
    await expect(fixedRow).toBeVisible();
    await expect(tieredRow).toBeVisible();
    // 梯度条目弹窗内无价:与单选路径同一「按数量套档」提示
    await expect(tieredRow).toContainText("按数量套档");

    // 数量未填齐禁止确认(必填拦截)
    const confirmButton = picker.getByRole("button", {
      name: "纳入订单",
      exact: true,
    });
    // HeroUI Checkbox 的真实 input 视觉隐藏、被装饰 span 覆盖;force 点击落在 label 内原生翻转
    await fixedRow.getByRole("checkbox").check({ force: true });
    await tieredRow.getByRole("checkbox").check({ force: true });
    await expect(picker.getByText("已选 2 条")).toBeVisible();
    await expect(confirmButton).toBeDisabled();

    await fixedRow
      .getByLabel(`数量 ${fixedItem.id.slice(0, 8)}`)
      .fill("5");
    await tieredRow
      .getByLabel(`数量 ${tieredItem.id.slice(0, 8)}`)
      .fill("20");
    // react-aria NumberField 失焦才提交值:点一下别处触发 commit
    await picker.getByText("已选 2 条").click();
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(picker).toBeHidden();

    // 子表即时呈现:固定价行金额本地算(5×12.5),梯度行提示套档
    const itemsTable = drawer.getByRole("grid", { name: "订单条目" });
    const fixedItemRow = itemsTable
      .getByRole("row")
      .filter({ hasText: `${prefix}M1` });
    const tieredItemRow = itemsTable
      .getByRole("row")
      .filter({ hasText: `${prefix}M2` });
    await expect(fixedItemRow).toContainText("62.50");
    await expect(tieredItemRow).toContainText("按数量套档");

    // 池剔除:两条报价条目都已在单上,再开选择器应为空态
    await drawer
      .getByRole("button", { name: "从报价批量选择", exact: true })
      .click();
    await expect(picker.getByText("无可选报价条目")).toBeVisible();
    await picker.getByRole("button", { name: "取消", exact: true }).click();
    await expect(picker).toBeHidden();

    const saveResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        new URL(candidate.url()).pathname ===
          `/api/v1/sales/orders/${orderId}`,
    );
    await drawer.getByRole("button", { name: "保存", exact: true }).click();
    const saved = await saveResponse;
    expect(saved.ok(), `${saved.status()} ${await saved.text()}`).toBeTruthy();
    await expect(page.getByText("销售订单已更新")).toBeVisible();

    // 后端权威结果:固定价带出 12.5;梯度按数量 20 套到第二档 8
    const items = await apiJSON<{
      results: Array<{
        materialId: string;
        qty: string;
        price: string;
        amount: string;
        pricingMode: string;
      }>;
    }>(request, "post", "/api/v1/sales/order-items/query", {
      limit: 10,
      offset: 0,
      filter: {
        orderId: {
          kind: "fk",
          op: "in",
          values: [orderId],
          labels: [],
        },
      },
    });
    expect(items.results).toHaveLength(2);
    const fixedSaved = items.results.find(
      (r) => r.materialId === fixture!.fixedMaterialId,
    )!;
    const tieredSaved = items.results.find(
      (r) => r.materialId === fixture!.tieredMaterialId,
    )!;
    expect(Number(fixedSaved.qty)).toBe(5);
    expect(Number(fixedSaved.price)).toBe(12.5);
    expect(Number(fixedSaved.amount)).toBe(62.5);
    expect(fixedSaved.pricingMode).toBe("FIXED");
    expect(Number(tieredSaved.qty)).toBe(20);
    expect(Number(tieredSaved.price)).toBe(8);
    expect(Number(tieredSaved.amount)).toBe(160);
    expect(tieredSaved.pricingMode).toBe("QTY_TIERED");
  } finally {
    if (fixture) {
      const orderIds = orderId ? `ARRAY['${orderId}'::uuid]` : "ARRAY[]::uuid[]";
      const quotationIds = quotationId
        ? `ARRAY['${quotationId}'::uuid]`
        : "ARRAY[]::uuid[]";
      postgres(`
        DELETE FROM sys_audit_log WHERE record_id=ANY(${orderIds}::uuid[] || ${quotationIds}::uuid[]);
        DELETE FROM sal_order WHERE id=ANY(${orderIds});
        DELETE FROM sal_quotation WHERE id=ANY(${quotationIds});
        DELETE FROM inv_material WHERE code LIKE '${prefix}%';
        DELETE FROM inv_material_category WHERE code LIKE '${prefix}%';
        DELETE FROM bas_unit WHERE symbol LIKE '${prefix}%';
        DELETE FROM sal_customers WHERE code LIKE '${prefix}%';
        DELETE FROM bas_company WHERE code LIKE '${prefix}%';
        DELETE FROM bas_currency WHERE iso_code LIKE '${prefix}%';
      `);
      const residue = postgres(`
        SELECT
          (SELECT count(*) FROM sal_order WHERE id=ANY(${orderIds})),
          (SELECT count(*) FROM sal_quotation WHERE id=ANY(${quotationIds})),
          (SELECT count(*) FROM inv_material WHERE code LIKE '${prefix}%'),
          (SELECT count(*) FROM bas_company WHERE code LIKE '${prefix}%');
      `);
      expect(residue, "批量报价验收夹具与业务记录必须精确归零").toBe(
        "0|0|0|0",
      );
    }
  }
});
