import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "admin123";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";

type List<T> = { count: number; results: T[] };
type RecordID = { id: string };
type Meta = {
  name: string;
  grid: Record<string, unknown> & { capabilities: string[] };
};
type APIError = { error?: { code?: string; message?: string } };

const db = new SQL(databaseURL);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR211${suffix}`;
const trackedIDs = new Set<string>();
let roleID: string | null = null;
let userID: string | null = null;
let ruleID: string | null = null;
/** 本脚本自建的公司/单位/币种（空库自愈），finally 中清理 */
let fixtureCompanyID: string | null = null;
let fixtureCurrencyID: string | null = null;
const fixtureUnitIDs: string[] = [];
/** 验收前临时停用的环境既有 inv.material 启用规则，finally 中恢复 */
const parkedRuleIDs: string[] = [];

const resources = [
  "invMaterialCategories",
  "invMaterials",
  "invMaterialUnits",
  "invWarehouses",
  "invStockEntries",
  "invStockDocs",
  "invStockDocItems",
  "invStockTransfers",
  "invStockTransferItems",
  "invStockCounts",
  "invStockCountItems",
] as const;

const masterReadPermissions = [
  "inv.material_category:read",
  "inv.material:read",
  "inv.warehouse:read",
];
const documentReadPermissions = [
  "inv.stock_entry:read",
  "inv.stock_doc:read",
  "inv.stock_transfer:read",
  "inv.stock_count:read",
];

function body(value: unknown) {
  return JSON.stringify(value);
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string) {
  const got = JSON.stringify(stable(actual));
  const want = JSON.stringify(stable(expected));
  if (got !== want) {
    throw new Error(
      `${label} 不一致\nactual=${JSON.stringify(actual, null, 2)}\nexpected=${JSON.stringify(expected, null, 2)}`,
    );
  }
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expected = 200,
) {
  const response = await fetch(baseURL + path, init);
  const text = await response.text();
  if (response.status !== expected) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as APIError;
      detail = `${parsed.error?.code ?? "unknown"}:${parsed.error?.message ?? text}`;
    } catch {
      // 保留非 JSON 响应。
    }
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status}, want ${expected}, ${detail}`,
    );
  }
  return text;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expected = 200,
): Promise<T> {
  const text = await requestText(path, init, expected);
  return text === "" ? (undefined as T) : (JSON.parse(text) as T);
}

async function snapshot(
  resource: (typeof resources)[number],
  actor: "superadmin" | "read-only",
) {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.11",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

async function create<T extends RecordID>(
  path: string,
  tokenHeaders: Record<string, string>,
  value: Record<string, unknown>,
) {
  const result = await request<T>(
    path,
    { method: "POST", headers: tokenHeaders, body: body(value) },
    201,
  );
  trackedIDs.add(result.id);
  return result;
}

async function cleanup() {
  const ids = [...trackedIDs];
  if (ids.length > 0) {
    const idArray = `{${ids.join(",")}}`;
    await db`DELETE FROM sys_audit_log WHERE record_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_entry WHERE voucher_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_count_item WHERE id = ANY(${idArray}::uuid[]) OR count_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_count WHERE id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_transfer_item WHERE id = ANY(${idArray}::uuid[]) OR stock_transfer_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_transfer WHERE id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_doc_item WHERE id = ANY(${idArray}::uuid[]) OR stock_doc_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_stock_doc WHERE id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_material_unit WHERE id = ANY(${idArray}::uuid[]) OR material_id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_material WHERE id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_warehouse WHERE id = ANY(${idArray}::uuid[])`;
    await db`DELETE FROM inv_material_category WHERE id = ANY(${idArray}::uuid[])`;
  }
  if (userID) {
    await db`DELETE FROM sys_user_role WHERE user_id = ${userID}::uuid`;
    await db`DELETE FROM sys_user_company WHERE user_id = ${userID}::uuid`;
    await db`DELETE FROM sys_user WHERE id = ${userID}::uuid`;
    userID = null;
  }
  if (roleID) {
    await db`DELETE FROM sys_role_permission WHERE role_id = ${roleID}::uuid`;
    await db`DELETE FROM sys_role WHERE id = ${roleID}::uuid`;
    roleID = null;
  }
  if (ruleID) {
    await db`DELETE FROM sys_numbering_counter WHERE rule_id = ${ruleID}::uuid`;
    await db`DELETE FROM sys_numbering_rule WHERE id = ${ruleID}::uuid`;
    ruleID = null;
  }
  // 恢复验收前临时停用的环境规则
  for (const id of parkedRuleIDs) {
    await db`UPDATE sys_numbering_rule SET enabled=true, updated_at=(now() AT TIME ZONE 'utc') WHERE id=${id}::uuid`;
  }
  parkedRuleIDs.length = 0;
  await db`DELETE FROM sys_audit_log WHERE changes::text LIKE ${"%" + prefix + "%"}`;
  // 空库自愈基线：仅删本脚本创建的公司/单位/币种（不碰环境已有）
  if (fixtureCompanyID) {
    await db`DELETE FROM inv_warehouse WHERE company_id = ${fixtureCompanyID}::uuid`;
    await db`DELETE FROM bas_company WHERE id = ${fixtureCompanyID}::uuid`;
    fixtureCompanyID = null;
  }
  if (fixtureUnitIDs.length > 0) {
    await db`DELETE FROM bas_unit WHERE id = ANY(${`{${fixtureUnitIDs.join(",")}}`}::uuid[])`;
    fixtureUnitIDs.length = 0;
  }
  if (fixtureCurrencyID) {
    await db`DELETE FROM bas_currency WHERE id = ${fixtureCurrencyID}::uuid`;
    fixtureCurrencyID = null;
  }
}

const login = await request<{ token: string }>("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body({ username, password }),
});
const adminHeaders = headers(login.token);

try {
  await cleanup();

  // 测试库刻意不依赖演示数据：公司 + 两单位缺失时自建（对齐 accounting/quotation 验收）。
  let companyId: string;
  let unitId: string;
  let altUnitId: string;

  const existingCompany = (await db`
    SELECT id::text AS id FROM bas_company ORDER BY inserted_at LIMIT 1
  `) as Array<{ id: string }>;
  if (existingCompany[0]) {
    companyId = existingCompany[0].id;
  } else {
    let currency = (await db`
      SELECT id::text AS id FROM bas_currency WHERE active = true ORDER BY inserted_at LIMIT 1
    `) as Array<{ id: string }>;
    if (!currency[0]) {
      currency = (await db`
        INSERT INTO bas_currency(name, iso_code, symbol, active)
        VALUES (${prefix + "币种"}, ${prefix.slice(0, 3)}, '¤', true)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      fixtureCurrencyID = currency[0]!.id;
    }
    const currencyId = currency[0]!.id;
    const companies = (await db`
      INSERT INTO bas_company(code, name, short_name, base_currency_id)
      VALUES (${prefix + "CO"}, ${prefix + "库存验收公司"}, ${prefix + "INV"}, ${currencyId}::uuid)
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    companyId = companies[0]!.id;
    fixtureCompanyID = companyId;
  }

  const existingUnits = (await db`
    SELECT id::text AS id FROM bas_unit ORDER BY is_base DESC, inserted_at
  `) as Array<{ id: string }>;
  if (existingUnits.length >= 2) {
    unitId = existingUnits[0]!.id;
    altUnitId = existingUnits[1]!.id;
  } else {
    // quantity 类型可插非基单位；避免撞 00003 行情种子 weight 基单位
    while (existingUnits.length < 2) {
      const n = existingUnits.length;
      const sym = `${prefix.slice(0, 6)}U${n}`;
      const inserted = (await db`
        INSERT INTO bas_unit(unit_type, is_base, name, symbol, ratio)
        VALUES (
          'quantity',
          false,
          ${prefix + "单位" + n},
          ${sym},
          ${n === 0 ? "1" : "2"}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      existingUnits.push(inserted[0]!);
      fixtureUnitIDs.push(inserted[0]!.id);
    }
    unitId = existingUnits[0]!.id;
    altUnitId = existingUnits[1]!.id;
  }
  assert(unitId !== altUnitId, "库存验收至少需要两个单位");

  for (const resource of resources) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, {
      headers: adminHeaders,
    });
    assertDeepEqual(
      meta.grid,
      await snapshot(resource, "superadmin"),
      `${resource} superadmin GridMeta`,
    );
  }

  const role = await create<RecordID>("/system/roles", adminHeaders, {
    code: `${prefix}READ`,
    name: `${prefix}库存只读`,
    enabled: true,
  });
  roleID = role.id;
  await request(`/system/roles/${role.id}/permissions`, {
    method: "PUT",
    headers: adminHeaders,
    body: body({ permissions: masterReadPermissions }),
  });
  const limited = await request<{
    user: { id: string; username: string };
    password: string;
  }>(
    "/system/users",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        username: `${prefix.toLowerCase()}reader`,
        name: `${prefix}库存只读`,
        roleIds: [role.id],
        companyIds: [companyId],
      }),
    },
    201,
  );
  userID = limited.user.id;
  trackedIDs.add(userID);
  const limitedLogin = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({
      username: limited.user.username,
      password: limited.password,
    }),
  });
  let readHeaders = headers(limitedLogin.token);
  for (const resource of resources.slice(0, 4)) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, {
      headers: readHeaders,
    });
    assertDeepEqual(
      meta.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only GridMeta`,
    );
    assertDeepEqual(meta.grid.capabilities, [], `${resource} 只读 capabilities`);
  }
  await request(`/system/roles/${role.id}/permissions`, {
    method: "PUT",
    headers: adminHeaders,
    body: body({ permissions: documentReadPermissions }),
  });
  const documentLogin = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({
      username: limited.user.username,
      password: limited.password,
    }),
  });
  readHeaders = headers(documentLogin.token);
  for (const resource of resources.slice(4)) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, {
      headers: readHeaders,
    });
    assertDeepEqual(
      meta.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only GridMeta`,
    );
    assertDeepEqual(meta.grid.capabilities, [], `${resource} 只读 capabilities`);
  }
  for (const path of [
    "/inventory/material-categories",
    "/inventory/materials",
    "/inventory/material-units",
    "/inventory/warehouses",
    "/inventory/stock-docs",
    "/inventory/stock-doc-items",
    "/inventory/stock-transfers",
    "/inventory/stock-transfer-items",
    "/inventory/stock-counts",
    "/inventory/stock-count-items",
  ]) {
    await requestText(
      path,
      { method: "POST", headers: readHeaders, body: "{" },
      403,
    );
  }

  // 自动编号段需要确定前缀；演示库可能已有 inv.material 启用规则，先停用再自建。
  const activeMaterialRules = (await db`
    SELECT id::text AS id
    FROM sys_numbering_rule
    WHERE resource='inv.material' AND enabled=true
  `) as RecordID[];
  for (const row of activeMaterialRules) {
    await db`UPDATE sys_numbering_rule SET enabled=false, updated_at=(now() AT TIME ZONE 'utc') WHERE id=${row.id}::uuid`;
    parkedRuleIDs.push(row.id);
  }
  const rule = await create<RecordID>("/system/numbering/rules", adminHeaders, {
    resource: "inv.material",
    name: `${prefix}物料编号`,
    segments: [
      { type: "text", value: `${prefix}M-` },
      { type: "seq", padding: 3 },
    ],
    perCompany: false,
    enabled: true,
  });
  ruleID = rule.id;

  const category = await create<RecordID>(
    "/inventory/material-categories",
    adminHeaders,
    {
      code: `${prefix}C`,
      name: `${prefix}分类`,
      isLeaf: true,
      active: true,
    },
  );
  const updatedCategory = await request<{ name: string }>(
    `/inventory/material-categories/${category.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ name: `${prefix}叶分类` }),
    },
  );
  assert(updatedCategory.name === `${prefix}叶分类`, "分类更新未生效");

  const material = await create<{
    id: string;
    code: string;
    category: { id: string };
    defaultUnit: { id: string };
  }>("/inventory/materials", adminHeaders, {
    name: `${prefix}物料`,
    spec: "REST/PG",
    categoryId: category.id,
    defaultUnitId: unitId,
  });
  assert(material.code === `${prefix}M-001`, "物料自动编号错误");
  assert(
    material.category.id === category.id && material.defaultUnit.id === unitId,
    "物料 REST DTO 缺少 join 引用",
  );

  const materialUnit = await create<{ id: string; factor: string }>(
    "/inventory/material-units",
    adminHeaders,
    { materialId: material.id, unitId: altUnitId, factor: "2" },
  );
  const updatedMaterialUnit = await request<{ factor: string }>(
    `/inventory/material-units/${materialUnit.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ factor: "4" }),
    },
  );
  assert(updatedMaterialUnit.factor === "4", "单位换算更新错误");

  const warehouses = [];
  for (const label of ["调出", "调入", "在途", "作废"]) {
    warehouses.push(
      await create<{ id: string; company: { id: string } }>(
        "/inventory/warehouses",
        adminHeaders,
        {
          name: `${prefix}${label}仓`,
          companyId,
          isLeaf: true,
          active: true,
          allowNegative: false,
        },
      ),
    );
  }
  assert(
    warehouses.every((warehouse) => warehouse.company.id === companyId),
    "仓库 DTO 公司引用错误",
  );
  const [fromWarehouse, toWarehouse, transitWarehouse, voidWarehouse] =
    warehouses;

  const inbound = await create<{ id: string; status: string }>(
    "/inventory/stock-docs",
    adminHeaders,
    {
      docNo: `${prefix}-IN`,
      direction: "IN",
      companyId,
      warehouseId: fromWarehouse.id,
      summary: "REST 入库",
    },
  );
  assert(inbound.status === "DRAFT", "入库单初态错误");
  const inboundItem = await create<{ id: string; baseQty: string }>(
    "/inventory/stock-doc-items",
    adminHeaders,
    {
      stockDocId: inbound.id,
      idx: 1,
      qty: "10",
      materialId: material.id,
      unitId,
    },
  );
  assert(inboundItem.baseQty === "10", "默认单位折算错误");
  const auditedInbound = await request<{ status: string }>(
    `/inventory/stock-docs/${inbound.id}/audit`,
    { method: "POST", headers: adminHeaders },
  );
  assert(auditedInbound.status === "AUDITED", "入库审核状态错误");

  const transfer = await create<{ id: string; status: string }>(
    "/inventory/stock-transfers",
    adminHeaders,
    {
      docNo: `${prefix}-TR`,
      companyId,
      fromWarehouseId: fromWarehouse.id,
      toWarehouseId: toWarehouse.id,
      transitWarehouseId: transitWarehouse.id,
    },
  );
  const transferItem = await create<{ id: string; receivedQty: string | null }>(
    "/inventory/stock-transfer-items",
    adminHeaders,
    {
      stockTransferId: transfer.id,
      idx: 1,
      qty: "4",
      materialId: material.id,
      unitId,
    },
  );
  const shipped = await request<{ status: string }>(
    `/inventory/stock-transfers/${transfer.id}/ship`,
    { method: "POST", headers: adminHeaders },
  );
  assert(shipped.status === "SHIPPED", "调拨发货状态错误");
  const received = await request<{ status: string }>(
    `/inventory/stock-transfers/${transfer.id}/receive`,
    { method: "POST", headers: adminHeaders, body: "{}" },
  );
  assert(received.status === "RECEIVED", "调拨收货状态错误");
  const receivedLine = await request<{ receivedQty: string }>(
    `/inventory/stock-transfer-items/${transferItem.id}`,
    { headers: adminHeaders },
  );
  assert(receivedLine.receivedQty === "4", "调拨实收回写错误");

  const count = await create<{ id: string; status: string }>(
    "/inventory/stock-counts",
    adminHeaders,
    {
      docNo: `${prefix}-CT`,
      companyId,
      warehouseId: toWarehouse.id,
      items: [
        {
          materialId: material.id,
          unitId,
          countedQuantity: "5",
        },
      ],
    },
  );
  const countItems = await request<List<{
    id: string;
    bookQuantity: string;
    countedQuantity: string;
  }>>("/inventory/stock-count-items/query", {
    method: "POST",
    headers: adminHeaders,
    body: body({
      limit: 20,
      offset: 0,
      filter: {
        countId: {
          kind: "fk",
          op: "in",
          values: [count.id],
          labels: [],
        },
      },
    }),
  });
  assert(
    countItems.count === 1 &&
      countItems.results[0]!.bookQuantity === "4" &&
      countItems.results[0]!.countedQuantity === "5",
    "盘点行原子创建/账面快照错误",
  );
  trackedIDs.add(countItems.results[0]!.id);
  const refreshed = await request<{ status: string }>(
    `/inventory/stock-counts/${count.id}/refresh`,
    { method: "POST", headers: adminHeaders },
  );
  assert(refreshed.status === "DRAFT", "盘点刷新不应改状态");
  const approved = await request<{ status: string }>(
    `/inventory/stock-counts/${count.id}/approve`,
    { method: "POST", headers: adminHeaders },
  );
  assert(approved.status === "AUDITED", "盘点审核状态错误");

  const balance = await request<{
    results: Array<{ warehouseId: string; quantity: string }>;
  }>("/inventory/stock-balance/query", {
    method: "POST",
    headers: adminHeaders,
    body: body({ companyId, materialId: material.id, hideZero: false }),
  });
  const quantities = Object.fromEntries(
    balance.results.map((row) => [row.warehouseId, row.quantity]),
  );
  assertDeepEqual(
    quantities,
    {
      [fromWarehouse.id]: "6",
      [toWarehouse.id]: "5",
      [transitWarehouse.id]: "0",
    },
    "审核后库存余额",
  );
  const cancelled = await request<{ status: string }>(
    `/inventory/stock-counts/${count.id}/cancel`,
    { method: "POST", headers: adminHeaders },
  );
  assert(cancelled.status === "CANCELLED", "盘点撤销状态错误");

  const voidDoc = await create<{ id: string }>(
    "/inventory/stock-docs",
    adminHeaders,
    {
      docNo: `${prefix}-VOID`,
      direction: "IN",
      companyId,
      warehouseId: voidWarehouse.id,
    },
  );
  await create<RecordID>("/inventory/stock-doc-items", adminHeaders, {
    stockDocId: voidDoc.id,
    idx: 1,
    qty: "2",
    materialId: material.id,
    unitId,
  });
  await request(`/inventory/stock-docs/${voidDoc.id}/audit`, {
    method: "POST",
    headers: adminHeaders,
  });
  const voided = await request<{ status: string }>(
    `/inventory/stock-docs/${voidDoc.id}/void`,
    { method: "POST", headers: adminHeaders },
  );
  assert(voided.status === "VOIDED", "入库单作废状态错误");
  await requestText(
    `/inventory/stock-docs/${inbound.id}/void`,
    { method: "POST", headers: adminHeaders },
    409,
  );

  const entries = await request<List<{ voucherId: string }>>(
    "/inventory/stock-entries/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        limit: 100,
        offset: 0,
        filter: {
          companyId: {
            kind: "fk",
            op: "in",
            values: [companyId],
            labels: [],
          },
          materialId: {
            kind: "fk",
            op: "in",
            values: [material.id],
            labels: [],
          },
        },
      }),
    },
  );
  assert(entries.count === 7, `库存分录条数=${entries.count}, want 7`);

  const auditIDArray = `{${[...trackedIDs].join(",")}}`;
  const auditSummary = (await db`
    SELECT resource, action_name AS "actionName", count(*)::int AS count
    FROM sys_audit_log
    WHERE record_id = ANY(${auditIDArray}::uuid[])
    GROUP BY resource, action_name
  `) as Array<{ resource: string; actionName: string; count: number }>;
  for (const required of [
    ["inv_stock_doc", "audit"],
    ["inv_stock_doc", "void"],
    ["inv_stock_transfer", "ship"],
    ["inv_stock_transfer", "receive"],
    ["inv_stock_count", "refresh"],
    ["inv_stock_count", "approve"],
    ["inv_stock_count", "cancel"],
  ]) {
    assert(
      auditSummary.some(
        (row) => row.resource === required[0] && row.actionName === required[1],
      ),
      `缺少审计动作 ${required.join("/")}`,
    );
  }

  await cleanup();
  const residue = (await db`
    SELECT
      (SELECT count(*) FROM inv_material_category WHERE code LIKE ${prefix + "%"})::int AS categories,
      (SELECT count(*) FROM inv_material WHERE code LIKE ${prefix + "%"})::int AS materials,
      (SELECT count(*) FROM inv_warehouse WHERE name LIKE ${prefix + "%"})::int AS warehouses,
      (SELECT count(*) FROM inv_stock_doc WHERE doc_no LIKE ${prefix + "%"})::int AS docs,
      (SELECT count(*) FROM inv_stock_transfer WHERE doc_no LIKE ${prefix + "%"})::int AS transfers,
      (SELECT count(*) FROM inv_stock_count WHERE doc_no LIKE ${prefix + "%"})::int AS counts
  `) as Array<Record<string, number>>;
  assert(
    Object.values(residue[0]!).every((value) => Number(value) === 0),
    `验收残留未归零: ${JSON.stringify(residue[0])}`,
  );
  console.log(
    "inventory REST acceptance ok: meta=22 permissionFirst=10 master=4 " +
      "stockDocs=2 transfer=1 count=1 entries=7 balances=3 audits=7 cleanup=0",
  );
} finally {
  await cleanup();
  await db.close();
}
