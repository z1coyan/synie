import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const db = new SQL(databaseURL);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR215${suffix}`;

type Row = Record<string, unknown> & { id: string };
type Fixture = {
  currencyId: string;
  companyId: string;
  customerId: string;
  supplierId: string;
  debitAccountId: string;
  creditAccountId: string;
};

const resources = [
  "salDeliveries",
  "salDeliveryItems",
  "purReceipts",
  "purReceiptItems",
  "purOutsourcedIssues",
  "purOutsourcedIssueItems",
  "purOutsourcedReceipts",
  "purOutsourcedReceiptItems",
  "purOutsourcedReceiptItemMaterials",
  "purOutsourcedReceiptItemByproducts",
] as const;

const queryPaths = [
  "/sales/deliveries/query",
  "/sales/delivery-items/query",
  "/purchase/receipts/query",
  "/purchase/receipt-items/query",
  "/purchase/outsourced-issues/query",
  "/purchase/outsourced-issue-items/query",
  "/purchase/outsourced-receipts/query",
  "/purchase/outsourced-receipt-items/query",
  "/purchase/outsourced-receipt-item-materials/query",
  "/purchase/outsourced-receipt-item-byproducts/query",
] as const;

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

async function login() {
  const result = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({
      username: process.env.E2E_ADMIN_USERNAME ?? "admin",
      password:
        process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password",
    }),
  });
  return headers(result.token);
}

async function createFixture(): Promise<Fixture> {
  const ids = {
    currencyId: crypto.randomUUID(),
    companyId: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    supplierId: crypto.randomUUID(),
    debitAccountId: crypto.randomUUID(),
    creditAccountId: crypto.randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES(${ids.currencyId}::uuid,${prefix + "验收币种"},${prefix + "CUR"},'¤',true)
    `;
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES(${ids.companyId}::uuid,${prefix + "CO"},${prefix + "验收公司"},${prefix + "CO"},${ids.currencyId}::uuid)
    `;
    await tx`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES(${ids.customerId}::uuid,${prefix + "CU"},${prefix + "验收客户"},${prefix + "CU"})
    `;
    await tx`
      INSERT INTO pur_supplier(id,code,name,short_name)
      VALUES(${ids.supplierId}::uuid,${prefix + "SU"},${prefix + "验收供应商"},${prefix + "SU"})
    `;
    await tx`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role)
      VALUES
        (${ids.debitAccountId}::uuid,${prefix + "D"},${prefix + "未开票应收"},'debit',false,true,${ids.companyId}::uuid,${ids.currencyId}::uuid,'unbilled_receivable'),
        (${ids.creditAccountId}::uuid,${prefix + "C"},${prefix + "未开票应付"},'credit',false,true,${ids.companyId}::uuid,${ids.currencyId}::uuid,'unbilled_payable')
    `;
  });
  return ids;
}

async function cleanup(fixture: Fixture, documentIds: string[]) {
  await db.begin(async (tx) => {
    void documentIds;
    await tx`DELETE FROM sys_audit_log WHERE record_label LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sal_delivery WHERE delivery_no LIKE ${prefix + "%"}`;
    await tx`DELETE FROM pur_receipt WHERE receipt_no LIKE ${prefix + "%"}`;
    await tx`DELETE FROM pur_outsourced_issue WHERE issue_no LIKE ${prefix + "%"}`;
    await tx`DELETE FROM pur_outsourced_receipt WHERE receipt_no LIKE ${prefix + "%"}`;
    await tx`DELETE FROM bas_account WHERE company_id=${fixture.companyId}::uuid`;
    await tx`DELETE FROM sal_customers WHERE id=${fixture.customerId}::uuid`;
    await tx`DELETE FROM pur_supplier WHERE id=${fixture.supplierId}::uuid`;
    await tx`DELETE FROM bas_company WHERE id=${fixture.companyId}::uuid`;
    await tx`DELETE FROM bas_currency WHERE id=${fixture.currencyId}::uuid`;
  });
}

let fixture: Fixture | null = null;
const documents: string[] = [];

try {
  fixture = await createFixture();
  const admin = await login();

  for (const resource of resources) {
    const actual = await request<{ grid: unknown }>(`/meta/resources/${resource}`, {
      headers: admin,
    });
    const expected = await Bun.file(
      join(
        import.meta.dir,
        "snapshots",
        "pr-2.15",
        `${resource}.superadmin.grid.json`,
      ),
    ).json();
    same(actual.grid, expected, `${resource} Meta`);
  }

  for (const path of queryPaths) {
    await requestText(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body({ limit: 20, offset: 0 }),
      },
      401,
    );
    await request<{ count: number; results: Row[] }>(path, {
      method: "POST",
      headers: admin,
      body: body({ limit: 20, offset: 0 }),
    });
  }

  const commonPurchase = {
    receiptDate: "2026-07-26",
    companyId: fixture.companyId,
    partyType: "SUPPLIER",
    partyId: fixture.supplierId,
    debitAccountId: fixture.debitAccountId,
    creditAccountId: fixture.creditAccountId,
  };
  const created = [
    await request<Row>(
      "/sales/deliveries",
      {
        method: "POST",
        headers: admin,
        body: body({
          deliveryNo: `${prefix}-SD`,
          deliveryDate: "2026-07-26",
          companyId: fixture.companyId,
          partyType: "CUSTOMER",
          partyId: fixture.customerId,
          debitAccountId: fixture.debitAccountId,
          creditAccountId: fixture.creditAccountId,
        }),
      },
      201,
    ),
    await request<Row>(
      "/purchase/receipts",
      {
        method: "POST",
        headers: admin,
        body: body({ ...commonPurchase, receiptNo: `${prefix}-PR` }),
      },
      201,
    ),
    await request<Row>(
      "/purchase/outsourced-issues",
      {
        method: "POST",
        headers: admin,
        body: body({
          issueNo: `${prefix}-OI`,
          issueDate: "2026-07-26",
          companyId: fixture.companyId,
          partyType: "SUPPLIER",
          partyId: fixture.supplierId,
        }),
      },
      201,
    ),
    await request<Row>(
      "/purchase/outsourced-receipts",
      {
        method: "POST",
        headers: admin,
        body: body({ ...commonPurchase, receiptNo: `${prefix}-OR` }),
      },
      201,
    ),
  ];
  documents.push(...created.map((row) => row.id));

  const defaultAccounts = await request<Record<string, unknown>>(
    `/sales/company-account-defaults/by-company/${fixture.companyId}`,
    { headers: admin },
  );
  assert(
    defaultAccounts.companyId === fixture.companyId,
    "公司默认科目只读 seam 未返回请求公司",
  );

  const endpoints = [
    "/sales/deliveries",
    "/purchase/receipts",
    "/purchase/outsourced-issues",
    "/purchase/outsourced-receipts",
  ];
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    const id = created[i]!.id;
    const got = await request<Row>(`${endpoint}/${id}`, { headers: admin });
    assert(got.id === id, `${endpoint} get id 不一致`);
    const updated = await request<Row>(`${endpoint}/${id}`, {
      method: "PATCH",
      headers: admin,
      body: body({ remarks: `${prefix}已更新` }),
    });
    assert(updated.remarks === `${prefix}已更新`, `${endpoint} update 未生效`);
  }

  for (let i = endpoints.length - 1; i >= 0; i--) {
    await requestText(
      `${endpoints[i]}/${created[i]!.id}`,
      { method: "DELETE", headers: admin },
      204,
    );
  }

  console.log(
    "fulfillment REST acceptance ok: meta=20 permissionFirst=10 queries=10 heads=4 defaults=1 cleanup=0",
  );
} finally {
  if (fixture) await cleanup(fixture, documents);
  await db.close();
}
