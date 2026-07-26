import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 10)
  .toUpperCase();
const prefix = `ZZR216${suffix}`;
const missingID = crypto.randomUUID();

type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type AuthHeaders = Record<string, string>;
type Reconciliation = Row & {
  reconciliationNo: string;
  reconciliationType: "REGULAR" | "GIFT_SAMPLE";
  postingDate: string | null;
  remarks: string | null;
  status: "DRAFT" | "CONFIRMED" | "CLOSED" | "VOIDED";
};
type ReconciliationItem = Row & {
  reconciliationId: string;
  qty: string;
  baseQty: string;
  amount: string;
  baseAmount: string;
};
type CompanyDefaults = Row & {
  companyId: string;
  deliveryDebitAccountId: string | null;
  deliveryCreditAccountId: string | null;
  receiptDebitAccountId: string | null;
  receiptCreditAccountId: string | null;
};
type OrderFlow = {
  id: string;
  flowType: string;
  voucherNo: string;
  orderId: string;
  orderItemId: string;
  companyId: string;
};
type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  unitId: string;
  categoryId: string;
  materialId: string;
  warehouseId: string;
  salesDebitId: string;
  salesCreditId: string;
  purchaseDebitId: string;
  purchaseCreditId: string;
  salesOrderId: string;
  salesOrderItemId: string;
  salesDeliveryId: string;
  salesDeliveryItemId: string;
  purchaseOrderId: string;
  purchaseOrderItemId: string;
  purchaseReceiptId: string;
  purchaseReceiptItemId: string;
  outsourcedOrderId: string;
  outsourcedOrderItemId: string;
  outsourcedReceiptId: string;
  outsourcedReceiptItemId: string;
};

const resources = [
  "salReconciliations",
  "salReconciliationItems",
  "salCompanyAccountDefaults",
  "purReconciliations",
  "purReconciliationItems",
  "scmOrderFlowItems",
] as const;

const readOnlyPermissions = [
  "sales.reconciliation:read",
  "purchase.reconciliation:read",
  "sales.setting:read",
  "sales.delivery:read",
];

const orderFlowPermissions = [
  "purchase.receipt:read",
  "purchase.outsourced_issue:read",
  "purchase.outsourced_receipt:read",
  "sales.delivery:read",
] as const;

let roleId: string | null = null;
let userId: string | null = null;
let graphqlCalls = 0;
let permissionFirst = 0;
const trackedReconciliations = new Set<string>();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function body(value: unknown) {
  return JSON.stringify(value);
}

function authHeaders(token: string): AuthHeaders {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
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

async function rawRequest(path: string, init: RequestInit = {}) {
  if (new URL(baseURL + path).pathname.endsWith("/graphql")) graphqlCalls++;
  return fetch(baseURL + path, init);
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expected = 200,
) {
  const response = await rawRequest(path, init);
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status}, want ${expected}, ${text}`,
    );
  }
  return text;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expected = 200,
) {
  const text = await requestText(path, init, expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function login(username: string, password: string) {
  const result = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ username, password }),
  });
  return authHeaders(result.token);
}

async function snapshot(resource: string, actor: "superadmin" | "read-only") {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.16",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

function fk(value: string) {
  return { kind: "fk", op: "in", values: [value], labels: [] };
}

async function query<T>(
  path: string,
  auth: AuthHeaders,
  filter: Record<string, unknown> = {},
) {
  return request<List<T>>(`${path}/query`, {
    method: "POST",
    headers: auth,
    body: body({ limit: 200, offset: 0, filter }),
  });
}

async function setPermissions(
  admin: AuthHeaders,
  permissions: readonly string[],
) {
  assert(roleId, "验收角色尚未创建");
  await request(`/system/roles/${roleId}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({ permissions }),
  });
}

async function expectPermissionFirst(path: string, init: RequestInit) {
  await requestText(path, init, 403);
  permissionFirst++;
}

async function createFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    currencyId: crypto.randomUUID(),
    companyId: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    supplierId: crypto.randomUUID(),
    unitId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    warehouseId: crypto.randomUUID(),
    salesDebitId: crypto.randomUUID(),
    salesCreditId: crypto.randomUUID(),
    purchaseDebitId: crypto.randomUUID(),
    purchaseCreditId: crypto.randomUUID(),
    salesOrderId: crypto.randomUUID(),
    salesOrderItemId: crypto.randomUUID(),
    salesDeliveryId: crypto.randomUUID(),
    salesDeliveryItemId: crypto.randomUUID(),
    purchaseOrderId: crypto.randomUUID(),
    purchaseOrderItemId: crypto.randomUUID(),
    purchaseReceiptId: crypto.randomUUID(),
    purchaseReceiptItemId: crypto.randomUUID(),
    outsourcedOrderId: crypto.randomUUID(),
    outsourcedOrderItemId: crypto.randomUUID(),
    outsourcedReceiptId: crypto.randomUUID(),
    outsourcedReceiptItemId: crypto.randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES(${fixture.currencyId}::uuid,${prefix + "验收币"},${"R" + suffix},'¤',true)
    `;
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES(${fixture.companyId}::uuid,${"C" + suffix},${prefix + "验收公司"},${prefix + "公司"},${fixture.currencyId}::uuid)
    `;
    await tx`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES(${fixture.customerId}::uuid,${"CU" + suffix},${prefix + "验收客户"},${prefix + "客户"})
    `;
    await tx`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES(${fixture.supplierId}::uuid,${"SU" + suffix},${prefix + "验收供应商"},${prefix + "供应商"})
    `;
    await tx`
      INSERT INTO bas_account(
        id,code,name,direction,is_group,active,company_id,currency_id,role
      ) VALUES
        (${fixture.salesDebitId}::uuid,${"SD" + suffix},${prefix + "销售借方"},'debit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid,NULL),
        (${fixture.salesCreditId}::uuid,${"SC" + suffix},${prefix + "未开票应收"},'credit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid,'unbilled_receivable'),
        (${fixture.purchaseDebitId}::uuid,${"PD" + suffix},${prefix + "未开票应付"},'debit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid,'unbilled_payable'),
        (${fixture.purchaseCreditId}::uuid,${"PC" + suffix},${prefix + "采购贷方"},'credit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid,NULL)
    `;
    await tx`
      INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio)
      VALUES(${fixture.unitId}::uuid,${"reconciliation-" + suffix},true,${prefix + "件"},${"U" + suffix},1)
    `;
    await tx`
      INSERT INTO inv_material_category(id,code,name,is_leaf,active)
      VALUES(${fixture.categoryId}::uuid,${"MC" + suffix},${prefix + "分类"},true,true)
    `;
    await tx`
      INSERT INTO inv_material(id,code,name,spec,category_id,default_unit_id,active)
      VALUES(${fixture.materialId}::uuid,${"M" + suffix},${prefix + "物料"},${"SPEC-" + suffix},${fixture.categoryId}::uuid,${fixture.unitId}::uuid,true)
    `;
    await tx`
      INSERT INTO inv_warehouse(id,name,company_id)
      VALUES(${fixture.warehouseId}::uuid,${prefix + "仓库"},${fixture.companyId}::uuid)
    `;
    await tx`
      INSERT INTO sal_order(
        id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,order_type
      ) VALUES(
        ${fixture.salesOrderId}::uuid,${prefix + "-SO"},'2026-07-20','customer',
        ${fixture.customerId}::uuid,'audited',${fixture.companyId}::uuid,1.2,
        ${fixture.currencyId}::uuid,'regular'
      )
    `;
    await tx`
      INSERT INTO sal_order_item(
        id,idx,qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name,base_qty
      ) VALUES(
        ${fixture.salesOrderItemId}::uuid,1,10,10,100,${fixture.salesOrderId}::uuid,
        ${fixture.companyId}::uuid,${fixture.materialId}::uuid,${fixture.unitId}::uuid,
        ${"M" + suffix},${prefix + "物料"},${prefix + "件"},20
      )
    `;
    await tx`
      INSERT INTO sal_delivery(
        id,delivery_no,delivery_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id
      ) VALUES(
        ${fixture.salesDeliveryId}::uuid,${prefix + "-SD"},'2026-07-25','customer',
        ${fixture.customerId}::uuid,'audited',${fixture.companyId}::uuid,
        ${fixture.warehouseId}::uuid,${fixture.salesCreditId}::uuid,${fixture.salesDebitId}::uuid
      )
    `;
    await tx`
      INSERT INTO sal_delivery_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        delivery_id,company_id,order_item_id,material_id,unit_id,warehouse_id
      ) VALUES(
        ${fixture.salesDeliveryItemId}::uuid,1,10,20,${"M" + suffix},
        ${prefix + "物料"},${prefix + "件"},${prefix + "-SO"},10,20,
        ${prefix + "件"},10,100,12,120,0.13,${"R" + suffix},
        ${fixture.salesDeliveryId}::uuid,${fixture.companyId}::uuid,
        ${fixture.salesOrderItemId}::uuid,${fixture.materialId}::uuid,
        ${fixture.unitId}::uuid,${fixture.warehouseId}::uuid
      )
    `;
    await tx`
      INSERT INTO pur_order(
        id,order_no,order_date,party_type,party_id,status,company_id,
        exchange_rate,currency_id,is_outsourced
      ) VALUES
        (${fixture.purchaseOrderId}::uuid,${prefix + "-PO"},'2026-07-20','supplier',
         ${fixture.supplierId}::uuid,'audited',${fixture.companyId}::uuid,1.2,
         ${fixture.currencyId}::uuid,false),
        (${fixture.outsourcedOrderId}::uuid,${prefix + "-OO"},'2026-07-20','supplier',
         ${fixture.supplierId}::uuid,'audited',${fixture.companyId}::uuid,1.2,
         ${fixture.currencyId}::uuid,true)
    `;
    await tx`
      INSERT INTO pur_order_item(
        id,idx,qty,base_qty,price,amount,order_id,company_id,material_id,unit_id,
        material_code,material_name,unit_name
      ) VALUES
        (${fixture.purchaseOrderItemId}::uuid,1,10,10,8,80,
         ${fixture.purchaseOrderId}::uuid,${fixture.companyId}::uuid,
         ${fixture.materialId}::uuid,${fixture.unitId}::uuid,${"M" + suffix},
         ${prefix + "物料"},${prefix + "件"}),
        (${fixture.outsourcedOrderItemId}::uuid,1,10,10,8,80,
         ${fixture.outsourcedOrderId}::uuid,${fixture.companyId}::uuid,
         ${fixture.materialId}::uuid,${fixture.unitId}::uuid,${"M" + suffix},
         ${prefix + "物料"},${prefix + "件"})
    `;
    await tx`
      INSERT INTO pur_receipt(
        id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id
      ) VALUES(
        ${fixture.purchaseReceiptId}::uuid,${prefix + "-PR"},'2026-07-25','supplier',
        ${fixture.supplierId}::uuid,'audited',${fixture.companyId}::uuid,
        ${fixture.warehouseId}::uuid,${fixture.purchaseCreditId}::uuid,
        ${fixture.purchaseDebitId}::uuid
      )
    `;
    await tx`
      INSERT INTO pur_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id
      ) VALUES(
        ${fixture.purchaseReceiptItemId}::uuid,1,10,10,${"M" + suffix},
        ${prefix + "物料"},${prefix + "件"},${prefix + "-PO"},10,10,
        ${prefix + "件"},8,80,9.6,96,0.13,${"R" + suffix},
        ${fixture.purchaseReceiptId}::uuid,${fixture.companyId}::uuid,
        ${fixture.purchaseOrderItemId}::uuid,${fixture.materialId}::uuid,
        ${fixture.unitId}::uuid,${fixture.warehouseId}::uuid
      )
    `;
    await tx`
      INSERT INTO pur_outsourced_receipt(
        id,receipt_no,receipt_date,party_type,party_id,status,company_id,
        warehouse_id,debit_account_id,credit_account_id
      ) VALUES(
        ${fixture.outsourcedReceiptId}::uuid,${prefix + "-OR"},'2026-07-25','supplier',
        ${fixture.supplierId}::uuid,'audited',${fixture.companyId}::uuid,
        ${fixture.warehouseId}::uuid,${fixture.purchaseCreditId}::uuid,
        ${fixture.purchaseDebitId}::uuid
      )
    `;
    await tx`
      INSERT INTO pur_outsourced_receipt_item(
        id,idx,qty,base_qty,material_code,material_name,unit_name,order_no,
        order_qty,order_base_qty,order_unit_name,order_price,order_amount,
        order_base_price,order_base_amount,order_tax_rate,order_currency_code,
        receipt_id,company_id,order_item_id,material_id,unit_id,warehouse_id
      ) VALUES(
        ${fixture.outsourcedReceiptItemId}::uuid,1,10,10,${"M" + suffix},
        ${prefix + "物料"},${prefix + "件"},${prefix + "-OO"},10,10,
        ${prefix + "件"},8,80,9.6,96,0.13,${"R" + suffix},
        ${fixture.outsourcedReceiptId}::uuid,${fixture.companyId}::uuid,
        ${fixture.outsourcedOrderItemId}::uuid,${fixture.materialId}::uuid,
        ${fixture.unitId}::uuid,${fixture.warehouseId}::uuid
      )
    `;
  });
  return fixture;
}

async function exerciseSide(
  side: "sales" | "purchase",
  admin: AuthHeaders,
  fixture: Fixture,
) {
  const headPath = `/${side}/reconciliations`;
  const itemPath = `/${side}/reconciliation-items`;
  const isSales = side === "sales";
  const partyType = isSales ? "CUSTOMER" : "SUPPLIER";
  const partyId = isSales ? fixture.customerId : fixture.supplierId;
  const debitAccountId = isSales
    ? fixture.salesDebitId
    : fixture.purchaseDebitId;
  const creditAccountId = isSales
    ? fixture.salesCreditId
    : fixture.purchaseCreditId;
  const sourceKey = isSales ? "deliveryItemId" : "receiptItemId";
  const sourceId = isSales
    ? fixture.salesDeliveryItemId
    : fixture.purchaseReceiptItemId;

  const regular = await request<Reconciliation>(
    headPath,
    {
      method: "POST",
      headers: admin,
      body: body({
        reconciliationNo: `${prefix}-${isSales ? "SR" : "PR"}-REG`,
        reconciliationType: "REGULAR",
        partyType,
        partyId,
        companyId: fixture.companyId,
        debitAccountId,
        creditAccountId,
      }),
    },
    201,
  );
  trackedReconciliations.add(regular.id);
  assert(regular.status === "DRAFT", `${side} 常规对账创建状态错误`);

  const updated = await request<Reconciliation>(`${headPath}/${regular.id}`, {
    method: "PATCH",
    headers: admin,
    body: body({ remarks: `${prefix}已更新` }),
  });
  assert(updated.remarks === `${prefix}已更新`, `${side} 对账头更新失败`);
  const gotHead = await request<Reconciliation>(`${headPath}/${regular.id}`, {
    headers: admin,
  });
  assert(gotHead.id === regular.id, `${side} 对账头 get 失败`);

  const item = await request<ReconciliationItem>(
    itemPath,
    {
      method: "POST",
      headers: admin,
      body: body({
        reconciliationId: regular.id,
        idx: 1,
        qty: "1.5",
        [sourceKey]: sourceId,
      }),
    },
    201,
  );
  const changedItem = await request<ReconciliationItem>(
    `${itemPath}/${item.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ qty: "2" }),
    },
  );
  assert(
    changedItem.qty === "2" &&
      typeof changedItem.baseQty === "string" &&
      typeof changedItem.amount === "string" &&
      typeof changedItem.baseAmount === "string",
    `${side} 对账行 Decimal 或 update 错误`,
  );
  const gotItem = await request<ReconciliationItem>(`${itemPath}/${item.id}`, {
    headers: admin,
  });
  assert(gotItem.id === item.id, `${side} 对账行 get 失败`);
  const heads = await query<Reconciliation>(headPath, admin, {
    companyId: fk(fixture.companyId),
  });
  const items = await query<ReconciliationItem>(itemPath, admin, {
    reconciliationId: fk(regular.id),
  });
  assert(
    heads.results.some((row) => row.id === regular.id) &&
      items.results.some((row) => row.id === item.id),
    `${side} 对账结构化 query 失败`,
  );

  const confirmed = await request<Reconciliation>(
    `${headPath}/${regular.id}/confirm`,
    { method: "POST", headers: admin },
  );
  assert(confirmed.status === "CONFIRMED", `${side} 对账确认失败`);
  const unconfirmed = await request<Reconciliation>(
    `${headPath}/${regular.id}/unconfirm`,
    { method: "POST", headers: admin },
  );
  assert(unconfirmed.status === "DRAFT", `${side} 对账撤回确认失败`);
  await requestText(
    `${itemPath}/${item.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  await requestText(
    `${headPath}/${regular.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  trackedReconciliations.delete(regular.id);

  const giftSourceKey = isSales ? "deliveryItemId" : "outsourcedReceiptItemId";
  const giftSourceId = isSales
    ? fixture.salesDeliveryItemId
    : fixture.outsourcedReceiptItemId;
  const gift = await request<Reconciliation>(
    headPath,
    {
      method: "POST",
      headers: admin,
      body: body({
        reconciliationNo: `${prefix}-${isSales ? "SR" : "PR"}-GIFT`,
        reconciliationType: "GIFT_SAMPLE",
        partyType,
        partyId,
        companyId: fixture.companyId,
        debitAccountId,
        creditAccountId,
      }),
    },
    201,
  );
  trackedReconciliations.add(gift.id);
  await request<ReconciliationItem>(
    itemPath,
    {
      method: "POST",
      headers: admin,
      body: body({
        reconciliationId: gift.id,
        idx: 1,
        qty: "1",
        [giftSourceKey]: giftSourceId,
      }),
    },
    201,
  );
  const closed = await request<Reconciliation>(`${headPath}/${gift.id}/audit`, {
    method: "POST",
    headers: admin,
    body: body({ postingDate: "2026-07-26" }),
  });
  assert(
    closed.status === "CLOSED" && closed.postingDate === "2026-07-26",
    `${side} 赠送/样品结单失败`,
  );
  const voided = await request<Reconciliation>(`${headPath}/${gift.id}/void`, {
    method: "POST",
    headers: admin,
  });
  assert(voided.status === "VOIDED", `${side} 赠送/样品作废失败`);
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
    await db`DELETE FROM sys_todo WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM sys_audit_log WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM acc_gl_entry WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM acc_vat_invoice WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM sal_reconciliation WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM pur_reconciliation WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM sal_company_account_default WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM sal_delivery WHERE id=${fixture.salesDeliveryId}::uuid`;
    await db`DELETE FROM pur_receipt WHERE id=${fixture.purchaseReceiptId}::uuid`;
    await db`DELETE FROM pur_outsourced_receipt WHERE id=${fixture.outsourcedReceiptId}::uuid`;
    await db`DELETE FROM sal_order WHERE id=${fixture.salesOrderId}::uuid`;
    await db`DELETE FROM pur_order WHERE id IN (${fixture.purchaseOrderId}::uuid,${fixture.outsourcedOrderId}::uuid)`;
    await db`DELETE FROM inv_warehouse WHERE id=${fixture.warehouseId}::uuid`;
    await db`DELETE FROM inv_material WHERE id=${fixture.materialId}::uuid`;
    await db`DELETE FROM inv_material_category WHERE id=${fixture.categoryId}::uuid`;
    await db`DELETE FROM bas_unit WHERE id=${fixture.unitId}::uuid`;
    await db`DELETE FROM bas_account WHERE company_id=${fixture.companyId}::uuid`;
    await db`DELETE FROM sal_customers WHERE id=${fixture.customerId}::uuid`;
    await db`DELETE FROM pur_supplier WHERE id=${fixture.supplierId}::uuid`;
    await db`DELETE FROM bas_company WHERE id=${fixture.companyId}::uuid`;
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
    const meta = await request<{ grid: unknown }>(
      `/meta/resources/${resource}`,
      {
        headers: admin,
      },
    );
    same(
      meta.grid,
      await snapshot(resource, "superadmin"),
      `${resource} superadmin Meta`,
    );
  }

  const regularDeliveryCandidates = await query<Row>(
    "/sales/delivery-items",
    admin,
    {
      companyId: fk(fixture.companyId),
      orderType: { kind: "enum", values: ["REGULAR"] },
    },
  );
  assert(
    regularDeliveryCandidates.results.some(
      (row) => row.id === fixture!.salesDeliveryItemId,
    ),
    "常规销售对账候选应包含常规订单来源",
  );
  await db`UPDATE sal_order SET order_type='sample' WHERE id=${fixture.salesOrderId}::uuid`;
  const sampleExcludedCandidates = await query<Row>(
    "/sales/delivery-items",
    admin,
    {
      companyId: fk(fixture.companyId),
      orderType: { kind: "enum", values: ["REGULAR"] },
    },
  );
  assert(
    !sampleExcludedCandidates.results.some(
      (row) => row.id === fixture!.salesDeliveryItemId,
    ),
    "常规销售对账候选不得包含样品订单来源",
  );
  await db`UPDATE sal_order SET order_type='regular' WHERE id=${fixture.salesOrderId}::uuid`;

  const role = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({ code: `${prefix}_reader`, name: `${prefix}验收角色` }),
    },
    201,
  );
  roleId = role.id;
  const limited = await request<{
    user: Row & { username: string };
    password: string;
  }>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}reader`,
        name: `${prefix}验收用户`,
        roleIds: [role.id],
        companyIds: [fixture.companyId],
      }),
    },
    201,
  );
  userId = limited.user.id;
  const noPermission = await login(limited.user.username, limited.password);
  for (const resource of resources) {
    await expectPermissionFirst(`/meta/resources/${resource}`, {
      headers: noPermission,
    });
  }
  for (const side of ["sales", "purchase"] as const) {
    const head = `/${side}/reconciliations`;
    const item = `/${side}/reconciliation-items`;
    await expectPermissionFirst(`${head}/query`, {
      method: "POST",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(head, {
      method: "POST",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(`${head}/${missingID}`, {
      headers: noPermission,
    });
    await expectPermissionFirst(`${head}/${missingID}`, {
      method: "PATCH",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(`${head}/${missingID}`, {
      method: "DELETE",
      headers: noPermission,
    });
    for (const action of ["confirm", "unconfirm", "audit", "void"]) {
      await expectPermissionFirst(`${head}/${missingID}/${action}`, {
        method: "POST",
        headers: noPermission,
        body: "{",
      });
    }
    await expectPermissionFirst(`${item}/query`, {
      method: "POST",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(item, {
      method: "POST",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(`${item}/${missingID}`, {
      headers: noPermission,
    });
    await expectPermissionFirst(`${item}/${missingID}`, {
      method: "PATCH",
      headers: noPermission,
      body: "{",
    });
    await expectPermissionFirst(`${item}/${missingID}`, {
      method: "DELETE",
      headers: noPermission,
    });
  }
  const defaults = "/sales/company-account-defaults";
  await expectPermissionFirst(`${defaults}/query`, {
    method: "POST",
    headers: noPermission,
    body: "{",
  });
  await expectPermissionFirst(defaults, {
    method: "POST",
    headers: noPermission,
    body: "{",
  });
  await expectPermissionFirst(`${defaults}/${missingID}`, {
    headers: noPermission,
  });
  await expectPermissionFirst(`${defaults}/${missingID}`, {
    method: "PATCH",
    headers: noPermission,
    body: "{",
  });
  await expectPermissionFirst(`${defaults}/by-company/${missingID}`, {
    headers: noPermission,
  });
  await expectPermissionFirst("/scm/order-flow-items/query", {
    method: "POST",
    headers: noPermission,
    body: "{",
  });
  await expectPermissionFirst(
    `/scm/order-flow-items/sales_delivery:${missingID}`,
    { headers: noPermission },
  );

  await setPermissions(admin, readOnlyPermissions);
  const readOnly = await login(limited.user.username, limited.password);
  for (const resource of resources) {
    const meta = await request<{ grid: unknown }>(
      `/meta/resources/${resource}`,
      {
        headers: readOnly,
      },
    );
    same(
      meta.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only Meta`,
    );
  }

  const createdDefaults = await request<CompanyDefaults>(
    defaults,
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyId,
        deliveryDebitAccountId: fixture.salesCreditId,
        deliveryCreditAccountId: fixture.salesDebitId,
        receiptDebitAccountId: fixture.purchaseCreditId,
        receiptCreditAccountId: fixture.purchaseDebitId,
      }),
    },
    201,
  );
  const listedDefaults = await query<CompanyDefaults>(defaults, admin, {
    companyId: fk(fixture.companyId),
  });
  const gotDefaults = await request<CompanyDefaults>(
    `${defaults}/${createdDefaults.id}`,
    { headers: admin },
  );
  const companyDefaults = await request<CompanyDefaults>(
    `${defaults}/by-company/${fixture.companyId}`,
    { headers: admin },
  );
  assert(
    listedDefaults.results.some((row) => row.id === createdDefaults.id) &&
      gotDefaults.id === createdDefaults.id &&
      companyDefaults.id === createdDefaults.id,
    "公司默认科目 list/get/by-company 表面错误",
  );

  await exerciseSide("sales", admin, fixture);
  await exerciseSide("purchase", admin, fixture);

  const cleared = await request<CompanyDefaults>(
    `${defaults}/${createdDefaults.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({
        deliveryDebitAccountId: null,
        deliveryCreditAccountId: null,
        receiptDebitAccountId: null,
        receiptCreditAccountId: null,
      }),
    },
  );
  assert(
    cleared.deliveryDebitAccountId === null &&
      cleared.deliveryCreditAccountId === null &&
      cleared.receiptDebitAccountId === null &&
      cleared.receiptCreditAccountId === null,
    "公司默认科目显式 null 清空失败",
  );
  const forbiddenDelete = await rawRequest(
    `${defaults}/${createdDefaults.id}`,
    {
      method: "DELETE",
      headers: admin,
    },
  );
  assert(
    forbiddenDelete.status === 404 || forbiddenDelete.status === 405,
    `公司默认科目不得暴露 DELETE，实际 ${forbiddenDelete.status}`,
  );
  await forbiddenDelete.body?.cancel();

  const flowFilter = { orderId: fk(fixture.salesOrderId) };
  let flowID = "";
  for (const permission of orderFlowPermissions) {
    await setPermissions(admin, [permission]);
    const sourceReader = await login(limited.user.username, limited.password);
    const result = await query<OrderFlow>(
      "/scm/order-flow-items",
      sourceReader,
      flowFilter,
    );
    const flow = result.results.find(
      (row) => row.orderItemId === fixture!.salesOrderItemId,
    );
    assert(flow, `${permission} 未满足订单流来源权限 OR`);
    assert(
      flow.id === `sales_delivery:${fixture.salesDeliveryItemId}` &&
        flow.flowType === "SALES_DELIVERY" &&
        flow.companyId === fixture.companyId,
      `${permission} 订单流 string id/序列化错误`,
    );
    flowID = flow.id;
    const got = await request<OrderFlow>(
      `/scm/order-flow-items/${encodeURIComponent(flowID)}`,
      { headers: sourceReader },
    );
    assert(got.id === flowID, `${permission} 订单流 get 失败`);
  }

  assert(graphqlCalls === 0, `REST 验收不得调用 GraphQL，实际 ${graphqlCalls}`);
  console.log(
    `supply reconciliation REST acceptance ok: meta=12 permissionFirst=${permissionFirst} ` +
      `sides=2 actions=8 defaults=1 nullSlots=4 noDelete=1 orderFlowOR=4 ` +
      `stringIds=1 candidateOrderType=2 graphql=${graphqlCalls} cleanup=0`,
  );
} finally {
  await cleanup(fixture);
}
