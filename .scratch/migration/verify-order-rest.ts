import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const db = new SQL(databaseURL);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR214${suffix}`;

type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type Meta = { grid: Record<string, unknown> & { capabilities: string[] } };
type Order = Row & {
  orderNo: string;
  orderType: "REGULAR" | "SAMPLE" | "SPOT";
  status: "DRAFT" | "AUDITED" | "CLOSED" | "VOIDED";
  companyId: string;
  currencyId: string;
};
type Item = Row & {
  orderId: string;
  orderNo: string;
  qty: string;
  price: string;
  amount: string;
  pricingMode: "FIXED" | "QTY_TIERED" | null;
  materialId: string;
  unitId: string;
  bomCode: string | null;
  demandNo: string | null;
};
type Fixture = {
  currencyId: string;
  companyA: string;
  companyB: string;
  customerId: string;
  supplierId: string;
  categoryId: string;
  unitId: string;
  boxId: string;
  materialId: string;
  byproductId: string;
  bomId: string;
  demandId: string;
  demandLineId: string;
  demandUserId: string;
};

const resources = [
  "salOrders",
  "salOrderItems",
  "purOrders",
  "purOrderItems",
  "purOrderItemMaterials",
  "purOrderItemByproducts",
] as const;
const tracked = new Set<string>();
let roleId: string | null = null;
let userId: string | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function body(value: unknown) {
  return JSON.stringify(value);
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function same(actual: unknown, expected: unknown, label: string) {
  const got = JSON.stringify(stable(actual));
  const want = JSON.stringify(stable(expected));
  assert(got === want, `${label} 不一致\nactual=${got}\nexpected=${want}`);
}

async function requestText(path: string, init: RequestInit = {}, expected = 200) {
  const response = await fetch(baseURL + path, init);
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status}, want ${expected}, ${text}`,
    );
  }
  return text;
}

async function request<T>(path: string, init: RequestInit = {}, expected = 200) {
  const text = await requestText(path, init, expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function login(username: string, password: string) {
  const result = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ username, password }),
  });
  return headers(result.token);
}

async function snapshot(resource: string, actor: "superadmin" | "read-only") {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.14",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

function fk(values: string[]) {
  return { kind: "fk", op: "in", values, labels: [] };
}

async function list<T>(
  path: string,
  auth: Record<string, string>,
  filter: Record<string, unknown> = {},
) {
  return request<List<T>>(`${path}/query`, {
    method: "POST",
    headers: auth,
    body: body({ limit: 200, offset: 0, filter }),
  });
}

async function createFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    currencyId: crypto.randomUUID(),
    companyA: crypto.randomUUID(),
    companyB: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    supplierId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    unitId: crypto.randomUUID(),
    boxId: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    byproductId: crypto.randomUUID(),
    bomId: crypto.randomUUID(),
    demandId: crypto.randomUUID(),
    demandLineId: crypto.randomUUID(),
    demandUserId: crypto.randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,active)
      VALUES(${fixture.currencyId}::uuid,${prefix + "币"},${"O" + suffix},true)
    `;
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES
        (${fixture.companyA}::uuid,${"A" + suffix},${prefix + "甲公司"},${prefix + "甲"},${fixture.currencyId}::uuid),
        (${fixture.companyB}::uuid,${"B" + suffix},${prefix + "乙公司"},${prefix + "乙"},${fixture.currencyId}::uuid)
    `;
    await tx`
      INSERT INTO sal_customers(id,code,name)
      VALUES(${fixture.customerId}::uuid,${"C" + suffix},${prefix + "客户"})
    `;
    await tx`
      INSERT INTO pur_supplier(id,code,name)
      VALUES(${fixture.supplierId}::uuid,${"S" + suffix},${prefix + "供应商"})
    `;
    await tx`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES
        (${fixture.unitId}::uuid,${"order-" + suffix},true,${prefix + "个"},${"EA" + suffix},1),
        (${fixture.boxId}::uuid,${"order-" + suffix},false,${prefix + "箱"},${"BOX" + suffix},10)
    `;
    await tx`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES(${fixture.categoryId}::uuid,${"MC" + suffix},${prefix + "分类"},true,true)
    `;
    await tx`
      INSERT INTO inv_material(id,code,name,spec,category_id,default_unit_id,is_customer_material)
      VALUES
        (${fixture.materialId}::uuid,${"M" + suffix},${prefix + "成品"},${"SPEC-" + suffix},${fixture.categoryId}::uuid,${fixture.unitId}::uuid,false),
        (${fixture.byproductId}::uuid,${"BP" + suffix},${prefix + "副产物"},NULL,${fixture.categoryId}::uuid,${fixture.unitId}::uuid,false)
    `;
    await tx`
      INSERT INTO inv_material_unit(material_id,unit_id,factor)
      VALUES(${fixture.materialId}::uuid,${fixture.boxId}::uuid,10)
    `;
    await tx`
      INSERT INTO mfg_bom(id,code,plan_name,material_id)
      VALUES(${fixture.bomId}::uuid,${"BOM-" + suffix},${prefix + "方案"},${fixture.materialId}::uuid)
    `;
    await tx`
      INSERT INTO mfg_bom_component(bom_id,material_id,unit_id,quantity,loss_rate,note)
      VALUES(${fixture.bomId}::uuid,${fixture.materialId}::uuid,${fixture.unitId}::uuid,1,0.1,'发料')
    `;
    await tx`
      INSERT INTO mfg_bom_byproduct(bom_id,material_id,unit_id,quantity,note)
      VALUES(${fixture.bomId}::uuid,${fixture.byproductId}::uuid,${fixture.unitId}::uuid,0.2,'副产物')
    `;
  });
  return fixture;
}

async function setPermissions(admin: Record<string, string>, permissions: string[]) {
  assert(roleId, "角色未创建");
  await request(`/system/roles/${roleId}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({ permissions }),
  });
}

async function setCompanies(admin: Record<string, string>, companyIds: string[]) {
  assert(userId, "用户未创建");
  await request(`/system/users/${userId}`, {
    method: "PATCH",
    headers: admin,
    body: body({ companyIds }),
  });
}

async function createQuotation(
  side: "sales" | "purchase",
  admin: Record<string, string>,
  fixture: Fixture,
  mode: "FIXED" | "QTY_TIERED",
) {
  const quote = await request<Row>(
    `/${side}/quotations`,
    {
      method: "POST",
      headers: admin,
      body: body({
        quotationNo: `${prefix}-${side === "sales" ? "S" : "P"}-${mode === "FIXED" ? "F" : "T"}`,
        quotationDate: "2026-07-01",
        validUntil: "2026-08-31",
        partyType: side === "sales" ? "CUSTOMER" : "SUPPLIER",
        partyId: side === "sales" ? fixture.customerId : fixture.supplierId,
        companyId: fixture.companyA,
        currencyId: fixture.currencyId,
      }),
    },
    201,
  );
  tracked.add(quote.id);
  const item = await request<Row>(
    `/${side}/quotation-items`,
    {
      method: "POST",
      headers: admin,
      body: body({
        quotationId: quote.id,
        idx: 1,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        pricingMode: mode,
        price: mode === "FIXED" ? "12.50" : null,
        taxRate: "0.13",
      }),
    },
    201,
  );
  tracked.add(item.id);
  if (mode === "QTY_TIERED") {
    for (const [minQty, price] of [
      ["1", "9"],
      ["10", "8"],
    ]) {
      const tier = await request<Row>(
        `/${side}/quotation-tiers`,
        {
          method: "POST",
          headers: admin,
          body: body({ itemId: item.id, minQty, price }),
        },
        201,
      );
      tracked.add(tier.id);
    }
  }
  await request(`/${side}/quotations/${quote.id}/audit`, {
    method: "POST",
    headers: admin,
  });
  return item;
}

async function cleanup(fixture: Fixture | null) {
  try {
    if (userId) {
      await db`DELETE FROM sys_user_role WHERE user_id=${userId}::uuid`;
      await db`DELETE FROM sys_user_company WHERE user_id=${userId}::uuid`;
      await db`DELETE FROM sys_user WHERE id=${userId}::uuid`;
      userId = null;
    }
    if (roleId) {
      await db`DELETE FROM sys_role_permission WHERE role_id=${roleId}::uuid`;
      await db`DELETE FROM sys_role WHERE id=${roleId}::uuid`;
      roleId = null;
    }
    if (!fixture) return;
    await db`DELETE FROM sys_attachment WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM sys_audit_log WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM sal_order WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM pur_order WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM sal_quotation WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM pur_quotation WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM mfg_demand WHERE id=${fixture.demandId}::uuid`;
    await db`DELETE FROM sys_user WHERE id=${fixture.demandUserId}::uuid`;
    await db`DELETE FROM mfg_bom WHERE id=${fixture.bomId}::uuid`;
    await db`DELETE FROM inv_material_unit WHERE material_id=${fixture.materialId}::uuid`;
    await db`DELETE FROM inv_material WHERE id IN (${fixture.materialId}::uuid,${fixture.byproductId}::uuid)`;
    await db`DELETE FROM inv_material_category WHERE id=${fixture.categoryId}::uuid`;
    await db`DELETE FROM bas_unit WHERE id IN (${fixture.unitId}::uuid,${fixture.boxId}::uuid)`;
    await db`DELETE FROM pur_supplier WHERE id=${fixture.supplierId}::uuid`;
    await db`DELETE FROM sal_customers WHERE id=${fixture.customerId}::uuid`;
    await db`DELETE FROM bas_company WHERE id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
    await db`DELETE FROM bas_currency WHERE id=${fixture.currencyId}::uuid`;
  } finally {
    await db.close();
  }
}

let fixture: Fixture | null = null;
try {
  fixture = await createFixture();
  const admin = await login(
    process.env.E2E_ADMIN_USERNAME ?? "admin",
    process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password",
  );

  for (const resource of resources) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, { headers: admin });
    same(meta.grid, await snapshot(resource, "superadmin"), `${resource} superadmin meta`);
  }

  const role = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({ code: `${prefix}_reader`, name: `${prefix}只读` }),
    },
    201,
  );
  roleId = role.id;
  await setPermissions(admin, []);
  const limited = await request<{ user: Row & { username: string }; password: string }>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}reader`,
        name: `${prefix}只读用户`,
        roleIds: [role.id],
        companyIds: [fixture.companyA],
      }),
    },
    201,
  );
  userId = limited.user.id;
  let reader = await login(limited.user.username, limited.password);
  const missing = crypto.randomUUID();
  for (const path of [
    "/sales/orders",
    "/sales/order-items",
    "/purchase/orders",
    "/purchase/order-items",
    "/purchase/order-item-materials",
    "/purchase/order-item-byproducts",
  ]) {
    await requestText(`${path}/query`, { method: "POST", headers: reader, body: "{" }, 403);
    await requestText(path, { method: "POST", headers: reader, body: "{" }, 403);
    await requestText(`${path}/${missing}`, { headers: reader }, 403);
    await requestText(`${path}/${missing}`, { method: "PATCH", headers: reader, body: "{" }, 403);
    await requestText(`${path}/${missing}`, { method: "DELETE", headers: reader }, 403);
  }
  for (const side of ["sales", "purchase"] as const) {
    for (const action of ["audit", "close", "void"]) {
      await requestText(
        `/${side}/orders/${missing}/${action}`,
        { method: "POST", headers: reader, body: "{" },
        403,
      );
    }
    await requestText(`/${side}/orders/${missing}/history`, { headers: reader }, 403);
  }
  await requestText(
    "/purchase/order-demand-lines/query",
    { method: "POST", headers: reader, body: "{" },
    403,
  );
  await requestText(
    "/purchase/order-bom/expand",
    { method: "POST", headers: reader, body: "{" },
    403,
  );

  await setPermissions(admin, ["sales.order:read", "purchase.order:read"]);
  reader = await login(limited.user.username, limited.password);
  for (const resource of resources) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, { headers: reader });
    same(meta.grid, await snapshot(resource, "read-only"), `${resource} read-only meta`);
  }

  const salesQuoteItem = await createQuotation("sales", admin, fixture, "FIXED");
  const purchaseQuoteItem = await createQuotation("purchase", admin, fixture, "QTY_TIERED");

  const salesHead = await request<Order>(
    "/sales/orders",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderNo: `${prefix}-SO`,
        orderDate: "2026-07-26",
        orderType: "REGULAR",
        partyType: "CUSTOMER",
        partyId: fixture.customerId,
        companyId: fixture.companyA,
      }),
    },
    201,
  );
  tracked.add(salesHead.id);
  const salesItem = await request<Item>(
    "/sales/order-items",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderId: salesHead.id,
        idx: 1,
        materialId: fixture.byproductId,
        unitId: fixture.boxId,
        qty: "20",
        quotationItemId: salesQuoteItem.id,
      }),
    },
    201,
  );
  assert(
    Number(salesItem.price) === 12.5 &&
      Number(salesItem.amount) === 250 &&
      salesItem.pricingMode === "FIXED" &&
      salesItem.materialId === fixture.materialId &&
      salesItem.unitId === fixture.unitId,
    "销售订单报价派生错误",
  );
  const salesItemList = await list<Item>("/sales/order-items", admin, {
    orderId: fk([salesHead.id]),
  });
  assert(salesItemList.count === 1, "销售订单条目查询错误");
  await request(`/sales/orders/${salesHead.id}/audit`, { method: "POST", headers: admin });
  const closedSales = await request<Order>(`/sales/orders/${salesHead.id}/close`, {
    method: "POST",
    headers: admin,
  });
  assert(closedSales.status === "CLOSED", "销售订单关闭失败");
  const emptySalesHistory = await request<{ results: unknown[] }>(
    `/sales/orders/${salesHead.id}/history`,
    { headers: admin },
  );
  assert(emptySalesHistory.results.length === 0, "新销售订单历史应为空");

  const sample = await request<Order>(
    "/sales/orders",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderNo: `${prefix}-SS`,
        orderDate: "2026-07-26",
        orderType: "SAMPLE",
        partyType: "COMPANY",
        partyId: fixture.companyA,
        companyId: fixture.companyB,
      }),
    },
    201,
  );
  tracked.add(sample.id);
  const sampleItem = await request<Item>(
    "/sales/order-items",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderId: sample.id,
        idx: 1,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        qty: "1",
        price: "0",
        taxRate: "0",
      }),
    },
    201,
  );
  tracked.add(sampleItem.id);
  await request(`/sales/orders/${sample.id}/audit`, {
    method: "POST",
    headers: admin,
  });
  const voidedSample = await request<Order>(`/sales/orders/${sample.id}/void`, {
    method: "POST",
    headers: admin,
  });
  assert(voidedSample.status === "VOIDED", "销售样品单作废失败");

  const purchaseRegular = await request<Order>(
    "/purchase/orders",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderNo: `${prefix}-PO-R`,
        orderDate: "2026-07-26",
        orderType: "REGULAR",
        partyType: "SUPPLIER",
        partyId: fixture.supplierId,
        companyId: fixture.companyA,
      }),
    },
    201,
  );
  tracked.add(purchaseRegular.id);
  const tiered = await request<Item>(
    "/purchase/order-items",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderId: purchaseRegular.id,
        idx: 1,
        materialId: fixture.byproductId,
        unitId: fixture.boxId,
        qty: "12",
        quotationItemId: purchaseQuoteItem.id,
      }),
    },
    201,
  );
  assert(
    tiered.pricingMode === "QTY_TIERED" && Number(tiered.price) === 8,
    "采购订单阶梯报价套档失败",
  );
  await request(`/purchase/orders/${purchaseRegular.id}/audit`, {
    method: "POST",
    headers: admin,
  });
  const closedPurchase = await request<Order>(
    `/purchase/orders/${purchaseRegular.id}/close`,
    { method: "POST", headers: admin },
  );
  assert(closedPurchase.status === "CLOSED", "采购订单关闭失败");

  await db`
    INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
    VALUES(${fixture.demandUserId}::uuid,${"demand-" + suffix},${prefix + "需求用户"},'test',false,false)
  `;
  await db`
    INSERT INTO mfg_demand(id,demand_no,demand_date,status,company_id,created_by_id)
    VALUES(${fixture.demandId}::uuid,${"D-" + suffix},CURRENT_DATE,'confirmed',${fixture.companyA}::uuid,${fixture.demandUserId}::uuid)
  `;
  await db`
    INSERT INTO mfg_demand_item(
      id,idx,qty,base_qty,need_date,fulfillment_method,status,material_code,
      material_name,unit_name,demand_id,company_id,material_id,unit_id,ordered_qty,received_qty
    ) VALUES(
      ${fixture.demandLineId}::uuid,1,5,5,CURRENT_DATE,'outsource','pending',
      ${"M" + suffix},${prefix + "成品"},${prefix + "个"},${fixture.demandId}::uuid,
      ${fixture.companyA}::uuid,${fixture.materialId}::uuid,${fixture.unitId}::uuid,0,0
    )
  `;
  const pool = await request<{ results: Array<Row & { suggestedQty: string }> }>(
    "/purchase/order-demand-lines/query",
    {
      method: "POST",
      headers: admin,
      body: body({ companyId: fixture.companyA, isOutsourced: true, limit: 200 }),
    },
  );
  assert(
    pool.results.some(
      (line) => line.id === fixture!.demandLineId && Number(line.suggestedQty) === 5,
    ),
    "采购需求池缺少目标行",
  );
  const preview = await request<{
    materials: Array<Row & { quantity: string; materialName: string; unitName: string }>;
    byproducts: Array<Row & { quantity: string }>;
  }>("/purchase/order-bom/expand", {
    method: "POST",
    headers: admin,
    body: body({ bomId: fixture.bomId, qty: "5" }),
  });
  assert(
    preview.materials.length === 1 &&
      preview.byproducts.length === 1 &&
      Number(preview.materials[0]!.quantity) === 5.5 &&
      preview.materials[0]!.materialName !== "" &&
      preview.materials[0]!.unitName !== "",
    "BOM 展开数量或展示字段错误",
  );

  const outsourced = await request<Order>(
    "/purchase/orders",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderNo: `${prefix}-PO-O`,
        orderDate: "2026-07-26",
        orderType: "SPOT",
        isOutsourced: true,
        partyType: "SUPPLIER",
        partyId: fixture.supplierId,
        companyId: fixture.companyA,
      }),
    },
    201,
  );
  tracked.add(outsourced.id);
  const outsourcedItem = await request<Item>(
    "/purchase/order-items",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderId: outsourced.id,
        idx: 1,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        qty: "5",
        price: "3",
        taxRate: "0.13",
        demandLineId: fixture.demandLineId,
        demandDate: "2026-07-26",
        bomId: fixture.bomId,
      }),
    },
    201,
  );
  assert(
    outsourcedItem.bomCode?.startsWith("BOM-") &&
      outsourcedItem.demandNo?.startsWith("D-"),
    "采购订单 BOM/需求来源投影缺失",
  );
  const material = await request<Row & { quantity: string; materialName: string }>(
    "/purchase/order-item-materials",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderItemId: outsourcedItem.id,
        materialId: fixture.materialId,
        unitId: fixture.unitId,
        quantity: "2",
        remarks: "发料",
      }),
    },
    201,
  );
  const byproduct = await request<Row & { quantity: string; materialName: string }>(
    "/purchase/order-item-byproducts",
    {
      method: "POST",
      headers: admin,
      body: body({
        orderItemId: outsourcedItem.id,
        materialId: fixture.byproductId,
        unitId: fixture.unitId,
        quantity: "1",
        remarks: "副产物",
      }),
    },
    201,
  );
  assert(material.materialName !== "" && byproduct.materialName !== "", "委外清单展示快照缺失");
  const updatedMaterial = await request<Row & { quantity: string }>(
    `/purchase/order-item-materials/${material.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ quantity: "2.5" }),
    },
  );
  assert(Number(updatedMaterial.quantity) === 2.5, "发料清单更新失败");
  const materialList = await list<Row>("/purchase/order-item-materials", admin, {
    orderItemId: fk([outsourcedItem.id]),
  });
  const byproductList = await list<Row>("/purchase/order-item-byproducts", admin, {
    orderItemId: fk([outsourcedItem.id]),
  });
  assert(materialList.count === 1 && byproductList.count === 1, "委外两清单查询错误");

  await request(`/purchase/orders/${outsourced.id}/audit`, {
    method: "POST",
    headers: admin,
  });
  const orderedAfterAudit = await db`
    SELECT ordered_qty::text AS ordered_qty
    FROM mfg_demand_item WHERE id=${fixture.demandLineId}::uuid
  `;
  assert(Number(orderedAfterAudit[0]!.ordered_qty) === 5, "审核未占用需求数量");
  await requestText(
    `/purchase/order-item-materials/${material.id}`,
    { method: "DELETE", headers: admin },
    409,
  );
  const voided = await request<Order>(`/purchase/orders/${outsourced.id}/void`, {
    method: "POST",
    headers: admin,
  });
  assert(voided.status === "VOIDED", "采购委外单作废失败");
  const orderedAfterVoid = await db`
    SELECT ordered_qty::text AS ordered_qty
    FROM mfg_demand_item WHERE id=${fixture.demandLineId}::uuid
  `;
  assert(Number(orderedAfterVoid[0]!.ordered_qty) === 0, "作废未释放需求数量");

  const readerSingle = await list<Order>("/purchase/orders", reader);
  assert(
    readerSingle.results.every((row) => row.companyId === fixture!.companyA),
    "单公司 scope 泄漏",
  );
  await setCompanies(admin, [fixture.companyA, fixture.companyB]);
  reader = await login(limited.user.username, limited.password);
  const readerMulti = await list<Order>("/sales/orders", reader);
  assert(
    readerMulti.results.some((row) => row.companyId === fixture!.companyB),
    "多公司 scope 未返回第二公司",
  );
  assert(userId, "用户缺失");
  await db`UPDATE sys_user SET all_companies=true WHERE id=${userId}::uuid`;
  reader = await login(limited.user.username, limited.password);
  const readerAll = await list<Order>("/purchase/orders", reader);
  assert(readerAll.count >= readerSingle.count, "全部公司 scope 结果错误");
  await db`UPDATE sys_user SET all_companies=false WHERE id=${userId}::uuid`;
  await setCompanies(admin, []);
  reader = await login(limited.user.username, limited.password);
  const readerEmpty = await list<Order>("/purchase/orders", reader);
  assert(readerEmpty.count === 0, "空公司 scope 应为空");

  const auditRows = await db`
    SELECT count(*)::int AS count
    FROM sys_audit_log
    WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)
      AND resource IN (
        'sal_order','sal_order_item','pur_order','pur_order_item',
        'pur_order_item_material','pur_order_item_byproduct'
      )
  `;
  assert(Number(auditRows[0]!.count) >= 16, "订单审计日志数量不足");

  console.log(
    `order REST acceptance ok: meta=12 permissionFirst=40 companyScope=single/multi/all/empty ` +
      `sales=fixed/audit/close/sample-void purchase=tier/audit/close demand=pool/occupy/release ` +
      `bom=expand materialCRUD=ok byproductCRUD=ok auditRows=${auditRows[0]!.count}`,
  );
} finally {
  await cleanup(fixture);
}
