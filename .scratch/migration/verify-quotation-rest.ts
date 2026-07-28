import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";

type APIError = { error?: { code?: string; message?: string } };
type RecordID = { id: string };
type List<T> = { count: number; results: T[] };
type Meta = {
  name: string;
  grid: Record<string, unknown> & { capabilities: string[] };
};
type Quotation = RecordID & {
  quotationNo: string;
  quotationDate: string;
  validUntil: string;
  partyType: string;
  partyId: string;
  terms: string | null;
  remarks: string | null;
  status: "DRAFT" | "AUDITED" | "VOIDED";
  auditedAt: string | null;
  companyId: string;
  currencyId: string;
  createdById: string | null;
  auditedById: string | null;
  company: { id: string; name: string };
  currency: { id: string; name: string; isoCode: string };
};
type QuotationItem = RecordID & {
  idx: number;
  pricingMode: "FIXED" | "QTY_TIERED";
  price: string | null;
  taxRate: string;
  materialCode: string;
  materialName: string;
  materialSpec: string | null;
  customerPartNo: string | null;
  unitName: string;
  remarks: string | null;
  quotationId: string;
  companyId: string;
  materialId: string;
  unitId: string;
  tierCount: number;
  quotationDate: string;
  validUntil: string;
  quotationStatus: "DRAFT" | "AUDITED" | "VOIDED";
  partyType: string;
  partyId: string;
  currencyCode: string;
};
type QuotationTier = RecordID & {
  minQty: string;
  price: string;
  itemId: string;
  companyId: string;
};
type Fixture = {
  currencyA: RecordID & { isoCode: string };
  currencyB: RecordID & { isoCode: string };
  companyA: RecordID;
  companyB: RecordID;
  customerA: RecordID;
  customerB: RecordID;
  supplier: RecordID;
  unit: RecordID;
  alternateUnit: RecordID;
  badUnit: RecordID;
  genericMaterial: RecordID;
  customerMaterial: RecordID;
};
type SideKey = "sales" | "purchase";
type Kind = "heads" | "items" | "tiers";
type SideSpec = {
  key: SideKey;
  label: string;
  permission: string;
  numberResource: string;
  resources: readonly [string, string, string];
  headPath: string;
  itemPath: string;
  tierPath: string;
  partyType: "CUSTOMER" | "SUPPLIER";
  auditResources: readonly [string, string, string];
};

const sides: readonly SideSpec[] = [
  {
    key: "sales",
    label: "销售",
    permission: "sales.quotation",
    numberResource: "sales.quotation",
    resources: ["salQuotations", "salQuotationItems", "salQuotationTiers"],
    headPath: "/sales/quotations",
    itemPath: "/sales/quotation-items",
    tierPath: "/sales/quotation-tiers",
    partyType: "CUSTOMER",
    auditResources: [
      "sal_quotation",
      "sal_quotation_item",
      "sal_quotation_tier",
    ],
  },
  {
    key: "purchase",
    label: "采购",
    permission: "purchase.quotation",
    numberResource: "purchase.quotation",
    resources: ["purQuotations", "purQuotationItems", "purQuotationTiers"],
    headPath: "/purchase/quotations",
    itemPath: "/purchase/quotation-items",
    tierPath: "/purchase/quotation-tiers",
    partyType: "SUPPLIER",
    auditResources: [
      "pur_quotation",
      "pur_quotation_item",
      "pur_quotation_tier",
    ],
  },
] as const;
const resources = sides.flatMap((side) => [...side.resources]);
const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 10)
  .toUpperCase();
const prefix = `ZZR213${suffix}`;
const trackedIDs = new Set<string>();
const quotationIDs = new Set<string>();
const itemIDs = new Set<string>();
const tierIDs = new Set<string>();
const numberingRuleIDs = new Set<string>();
const fixtureCompanyIDs = new Set<string>();
const fixtureCurrencyIDs = new Set<string>();
const fixturePartyIDs = new Set<string>();
const fixtureUnitIDs = new Set<string>();
const fixtureMaterialIDs = new Set<string>();
let fixtureCategoryID: string | null = null;
let roleID: string | null = null;
let userID: string | null = null;

const active = Object.fromEntries(
  sides.map((side) => [
    side.key,
    {
      heads: new Map<string, string>(),
      items: new Map<string, string>(),
      tiers: new Map<string, string>(),
    },
  ]),
) as Record<SideKey, Record<Kind, Map<string, string>>>;

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

function assertDecimal(value: unknown, expected: number, label: string) {
  assert(typeof value === "string", `${label} 必须以 JSON string 返回`);
  assert(Number(value) === expected, `${label}=${value}, want ${expected}`);
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

async function loginAs(loginUsername: string, loginPassword: string) {
  const result = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ username: loginUsername, password: loginPassword }),
  });
  return headers(result.token);
}

async function snapshot(resource: string, actor: "superadmin" | "read-only") {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.13",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

function fk(values: string[]) {
  return { kind: "fk", op: "in", values, labels: [] };
}

function polyFk(variant: string, values: string[]) {
  return { kind: "polyFk", op: "in", variant, values, labels: [] };
}

function pathFor(side: SideSpec, kind: Kind) {
  if (kind === "heads") return side.headPath;
  if (kind === "items") return side.itemPath;
  return side.tierPath;
}

async function query<T>(
  side: SideSpec,
  kind: Kind,
  tokenHeaders: Record<string, string>,
  filter: Record<string, unknown> = {},
  search?: string,
) {
  return request<List<T>>(`${pathFor(side, kind)}/query`, {
    method: "POST",
    headers: tokenHeaders,
    body: body({ limit: 200, offset: 0, search, filter }),
  });
}

async function createQuotation(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  input: Record<string, unknown>,
) {
  const result = await request<Quotation>(
    side.headPath,
    { method: "POST", headers: tokenHeaders, body: body(input) },
    201,
  );
  quotationIDs.add(result.id);
  trackedIDs.add(result.id);
  active[side.key].heads.set(result.id, result.companyId);
  return result;
}

async function deleteQuotation(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  quotation: Quotation,
) {
  await requestText(
    `${side.headPath}/${quotation.id}`,
    { method: "DELETE", headers: tokenHeaders },
    204,
  );
  active[side.key].heads.delete(quotation.id);
  for (const [id, companyID] of active[side.key].items) {
    if (companyID === quotation.companyId) {
      // 精确的子记录集合会在后续 scope 对拍前由实际 GET/查询再次校正。
      const rows =
        side.key === "sales"
          ? await db`
            SELECT id::text AS id
            FROM sal_quotation_item
            WHERE id=${id}::uuid
            `
          : await db`
            SELECT id::text AS id
            FROM pur_quotation_item
            WHERE id=${id}::uuid
            `;
      if (rows.length === 0) active[side.key].items.delete(id);
    }
  }
  for (const id of active[side.key].tiers.keys()) {
    const rows =
      side.key === "sales"
        ? await db`
            SELECT id::text AS id
            FROM sal_quotation_tier
            WHERE id=${id}::uuid
          `
        : await db`
            SELECT id::text AS id
            FROM pur_quotation_tier
            WHERE id=${id}::uuid
          `;
    if (rows.length === 0) active[side.key].tiers.delete(id);
  }
}

async function createItem(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  input: Record<string, unknown>,
) {
  const result = await request<QuotationItem>(
    side.itemPath,
    { method: "POST", headers: tokenHeaders, body: body(input) },
    201,
  );
  itemIDs.add(result.id);
  trackedIDs.add(result.id);
  active[side.key].items.set(result.id, result.companyId);
  return result;
}

async function deleteItem(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  item: QuotationItem,
) {
  await requestText(
    `${side.itemPath}/${item.id}`,
    { method: "DELETE", headers: tokenHeaders },
    204,
  );
  active[side.key].items.delete(item.id);
  for (const id of active[side.key].tiers.keys()) {
    const rows =
      side.key === "sales"
        ? await db`
            SELECT id::text AS id
            FROM sal_quotation_tier
            WHERE id=${id}::uuid
          `
        : await db`
            SELECT id::text AS id
            FROM pur_quotation_tier
            WHERE id=${id}::uuid
          `;
    if (rows.length === 0) active[side.key].tiers.delete(id);
  }
}

async function createTier(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  input: Record<string, unknown>,
) {
  const result = await request<QuotationTier>(
    side.tierPath,
    { method: "POST", headers: tokenHeaders, body: body(input) },
    201,
  );
  tierIDs.add(result.id);
  trackedIDs.add(result.id);
  active[side.key].tiers.set(result.id, result.companyId);
  return result;
}

async function deleteTier(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  tier: QuotationTier,
) {
  await requestText(
    `${side.tierPath}/${tier.id}`,
    { method: "DELETE", headers: tokenHeaders },
    204,
  );
  active[side.key].tiers.delete(tier.id);
}

async function setPermissions(
  adminHeaders: Record<string, string>,
  permissions: string[],
) {
  assert(roleID, "报价验收角色尚未创建");
  await request(`/system/roles/${roleID}/permissions`, {
    method: "PUT",
    headers: adminHeaders,
    body: body({ permissions }),
  });
}

async function setCompanies(
  adminHeaders: Record<string, string>,
  companyIDs: string[],
) {
  assert(userID, "报价验收用户尚未创建");
  await request(`/system/users/${userID}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: body({ companyIds: companyIDs }),
  });
}

async function cleanup() {
  if (userID) {
    await db`UPDATE sys_user SET all_companies=false WHERE id=${userID}::uuid`;
  }
  const ids = [...trackedIDs];
  if (ids.length > 0) {
    const idArray = `{${ids.join(",")}}`;
    await db`DELETE FROM sys_audit_log WHERE record_id=ANY(${idArray}::uuid[])`;
  }
  // 进程中断后内存集合可能丢失，先从唯一单号前缀恢复业务记录并清理审计。
  await db`
    DELETE FROM sys_audit_log
    WHERE record_id IN (
      SELECT id FROM sal_quotation WHERE quotation_no LIKE ${prefix + "%"}
      UNION ALL SELECT id FROM pur_quotation WHERE quotation_no LIKE ${prefix + "%"}
      UNION ALL
      SELECT i.id FROM sal_quotation_item i
      JOIN sal_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
      UNION ALL
      SELECT i.id FROM pur_quotation_item i
      JOIN pur_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
      UNION ALL
      SELECT t.id FROM sal_quotation_tier t
      JOIN sal_quotation_item i ON i.id=t.item_id
      JOIN sal_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
      UNION ALL
      SELECT t.id FROM pur_quotation_tier t
      JOIN pur_quotation_item i ON i.id=t.item_id
      JOIN pur_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
    )
  `;
  await db`
    DELETE FROM sal_quotation_tier
    WHERE item_id IN (
      SELECT i.id FROM sal_quotation_item i
      JOIN sal_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
    )
  `;
  await db`
    DELETE FROM pur_quotation_tier
    WHERE item_id IN (
      SELECT i.id FROM pur_quotation_item i
      JOIN pur_quotation q ON q.id=i.quotation_id
      WHERE q.quotation_no LIKE ${prefix + "%"}
    )
  `;
  await db`
    DELETE FROM sal_quotation_item
    WHERE quotation_id IN (
      SELECT id FROM sal_quotation WHERE quotation_no LIKE ${prefix + "%"}
    )
  `;
  await db`
    DELETE FROM pur_quotation_item
    WHERE quotation_id IN (
      SELECT id FROM pur_quotation WHERE quotation_no LIKE ${prefix + "%"}
    )
  `;
  await db`DELETE FROM sal_quotation WHERE quotation_no LIKE ${prefix + "%"}`;
  await db`DELETE FROM pur_quotation WHERE quotation_no LIKE ${prefix + "%"}`;
  await db`
    DELETE FROM sys_numbering_counter
    WHERE rule_id IN (
      SELECT id FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}
    )
  `;
  await db`DELETE FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}`;
  if (userID) {
    await db`DELETE FROM sys_user_role WHERE user_id=${userID}::uuid`;
    await db`DELETE FROM sys_user_company WHERE user_id=${userID}::uuid`;
    await db`DELETE FROM sys_user WHERE id=${userID}::uuid`;
    userID = null;
  }
  if (roleID) {
    await db`DELETE FROM sys_role_permission WHERE role_id=${roleID}::uuid`;
    await db`DELETE FROM sys_role WHERE id=${roleID}::uuid`;
    roleID = null;
  }
  await db`
    DELETE FROM sys_user_role
    WHERE user_id IN (
      SELECT id FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"}
    )
  `;
  await db`
    DELETE FROM sys_user_company
    WHERE user_id IN (
      SELECT id FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"}
    )
  `;
  await db`
    DELETE FROM sys_user
    WHERE username::text LIKE ${prefix.toLowerCase() + "%"}
  `;
  await db`
    DELETE FROM sys_role_permission
    WHERE role_id IN (
      SELECT id FROM sys_role WHERE code LIKE ${prefix + "%"}
    )
  `;
  await db`DELETE FROM sys_role WHERE code LIKE ${prefix + "%"}`;
  await db`
    DELETE FROM inv_material_unit
    WHERE material_id IN (
      SELECT id FROM inv_material WHERE code LIKE ${prefix + "%"}
    )
  `;
  await db`DELETE FROM inv_material WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM inv_material_category WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM pur_supplier WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM sal_customers WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_unit WHERE symbol LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_company WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_currency WHERE iso_code LIKE ${prefix + "%"}`;
  await db`DELETE FROM sys_audit_log WHERE changes::text LIKE ${"%" + prefix + "%"}`;
  numberingRuleIDs.clear();
}

async function assertCleanupZero() {
  const ids = [...trackedIDs];
  const auditCount =
    ids.length === 0
      ? 0
      : Number(
          (
            (await db`
              SELECT count(*)::int AS count
              FROM sys_audit_log
              WHERE record_id=ANY(${"{" + ids.join(",") + "}"}::uuid[])
            `) as Array<{ count: number }>
          )[0]!.count,
        );
  const rows = (await db`
    SELECT
      (SELECT count(*) FROM sal_quotation WHERE quotation_no LIKE ${prefix + "%"})::int AS sal_heads,
      (SELECT count(*) FROM pur_quotation WHERE quotation_no LIKE ${prefix + "%"})::int AS pur_heads,
      (SELECT count(*) FROM sal_quotation_item i JOIN sal_quotation q ON q.id=i.quotation_id WHERE q.quotation_no LIKE ${prefix + "%"})::int AS sal_items,
      (SELECT count(*) FROM pur_quotation_item i JOIN pur_quotation q ON q.id=i.quotation_id WHERE q.quotation_no LIKE ${prefix + "%"})::int AS pur_items,
      (SELECT count(*) FROM sal_quotation_tier t JOIN sal_quotation_item i ON i.id=t.item_id JOIN sal_quotation q ON q.id=i.quotation_id WHERE q.quotation_no LIKE ${prefix + "%"})::int AS sal_tiers,
      (SELECT count(*) FROM pur_quotation_tier t JOIN pur_quotation_item i ON i.id=t.item_id JOIN pur_quotation q ON q.id=i.quotation_id WHERE q.quotation_no LIKE ${prefix + "%"})::int AS pur_tiers,
      (SELECT count(*) FROM sal_customers WHERE code LIKE ${prefix + "%"})::int AS customers,
      (SELECT count(*) FROM pur_supplier WHERE code LIKE ${prefix + "%"})::int AS suppliers,
      (SELECT count(*) FROM inv_material WHERE code LIKE ${prefix + "%"})::int AS materials,
      (SELECT count(*) FROM inv_material_category WHERE code LIKE ${prefix + "%"})::int AS categories,
      (SELECT count(*) FROM bas_unit WHERE symbol LIKE ${prefix + "%"})::int AS units,
      (SELECT count(*) FROM bas_company WHERE code LIKE ${prefix + "%"})::int AS companies,
      (SELECT count(*) FROM bas_currency WHERE iso_code LIKE ${prefix + "%"})::int AS currencies,
      (SELECT count(*) FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})::int AS numbering_rules,
      (SELECT count(*) FROM sys_numbering_counter c JOIN sys_numbering_rule r ON r.id=c.rule_id WHERE r.name LIKE ${prefix + "%"})::int AS numbering_counters,
      (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"})::int AS roles,
      (SELECT count(*) FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"})::int AS users
  `) as Array<Record<string, number>>;
  const residue = { ...rows[0]!, audits: auditCount };
  assert(
    Object.values(residue).every((value) => Number(value) === 0),
    `报价验收残留未归零: ${JSON.stringify(residue)}`,
  );
}

async function createFixture(): Promise<Fixture> {
  const currencies = (await db`
    INSERT INTO bas_currency(name,iso_code,symbol,active)
    VALUES
      (${prefix + "本币"},${prefix + "A"},'A$',true),
      (${prefix + "外币"},${prefix + "B"},'B$',true)
    RETURNING id::text AS id,iso_code AS "isoCode"
  `) as Array<RecordID & { isoCode: string }>;
  const currencyA = currencies.find((item) => item.isoCode === `${prefix}A`)!;
  const currencyB = currencies.find((item) => item.isoCode === `${prefix}B`)!;
  for (const item of currencies) {
    fixtureCurrencyIDs.add(item.id);
    trackedIDs.add(item.id);
  }
  const companies = (await db`
    INSERT INTO bas_company(code,name,short_name,base_currency_id)
    VALUES
      (${prefix + "CA"},${prefix + "公司A"},${prefix + "A"},${currencyA.id}::uuid),
      (${prefix + "CB"},${prefix + "公司B"},${prefix + "B"},${currencyA.id}::uuid)
    RETURNING id::text AS id,code
  `) as Array<RecordID & { code: string }>;
  const companyA = companies.find((item) => item.code === `${prefix}CA`)!;
  const companyB = companies.find((item) => item.code === `${prefix}CB`)!;
  for (const item of companies) {
    fixtureCompanyIDs.add(item.id);
    trackedIDs.add(item.id);
  }
  const customers = (await db`
    INSERT INTO sal_customers(code,name,short_name)
    VALUES
      (${prefix + "C1"},${prefix + "客户一"},${prefix + "C1"}),
      (${prefix + "C2"},${prefix + "客户二"},${prefix + "C2"})
    RETURNING id::text AS id,code
  `) as Array<RecordID & { code: string }>;
  const customerA = customers.find((item) => item.code === `${prefix}C1`)!;
  const customerB = customers.find((item) => item.code === `${prefix}C2`)!;
  const suppliers = (await db`
    INSERT INTO pur_supplier(code,name,short_name)
    VALUES (${prefix + "S1"},${prefix + "供应商"},${prefix + "S1"})
    RETURNING id::text AS id
  `) as RecordID[];
  const supplier = suppliers[0]!;
  for (const item of [...customers, supplier]) {
    fixturePartyIDs.add(item.id);
    trackedIDs.add(item.id);
  }
  // 演示库可能已有 quantity 基准；自建非基准「个」作默认单位，避免 unique_base 冲突且保证 name 可断言
  const hasBase = (await db`
    SELECT 1 FROM bas_unit WHERE unit_type='quantity' AND is_base=true LIMIT 1
  `) as Array<unknown>;
  const units = (await db`
    INSERT INTO bas_unit(unit_type,is_base,name,symbol,ratio)
    VALUES
      ('quantity',${hasBase.length === 0},${prefix + "个"},${prefix + "EA"},1),
      ('quantity',false,${prefix + "箱"},${prefix + "BOX"},10),
      ('quantity',false,${prefix + "非法单位"},${prefix + "BAD"},1)
    RETURNING id::text AS id,symbol
  `) as Array<RecordID & { symbol: string }>;
  const unit = units.find((item) => item.symbol === `${prefix}EA`)!;
  const alternateUnit = units.find((item) => item.symbol === `${prefix}BOX`)!;
  const badUnit = units.find((item) => item.symbol === `${prefix}BAD`)!;
  for (const item of units) {
    fixtureUnitIDs.add(item.id);
    trackedIDs.add(item.id);
  }
  const categories = (await db`
    INSERT INTO inv_material_category(code,name,is_leaf,active)
    VALUES (${prefix + "MC"},${prefix + "物料分类"},true,true)
    RETURNING id::text AS id
  `) as RecordID[];
  fixtureCategoryID = categories[0]!.id;
  trackedIDs.add(fixtureCategoryID);
  const materials = (await db`
    INSERT INTO inv_material(
      code,name,spec,customer_part_no,category_id,default_unit_id,
      is_customer_material,customer_id
    )
    VALUES
      (
        ${prefix + "M1"},${prefix + "通用物料"},${prefix + "SPEC"},NULL,
        ${fixtureCategoryID}::uuid,${unit.id}::uuid,false,NULL
      ),
      (
        ${prefix + "CM"},${prefix + "客户物料"},${prefix + "CSPEC"},
        ${prefix + "CP"},${fixtureCategoryID}::uuid,${unit.id}::uuid,
        true,${customerA.id}::uuid
      )
    RETURNING id::text AS id,code
  `) as Array<RecordID & { code: string }>;
  const genericMaterial = materials.find(
    (item) => item.code === `${prefix}M1`,
  )!;
  const customerMaterial = materials.find(
    (item) => item.code === `${prefix}CM`,
  )!;
  for (const item of materials) {
    fixtureMaterialIDs.add(item.id);
    trackedIDs.add(item.id);
  }
  await db`
    INSERT INTO inv_material_unit(material_id,unit_id,factor)
    VALUES (${genericMaterial.id}::uuid,${alternateUnit.id}::uuid,10)
  `;
  return {
    currencyA,
    currencyB,
    companyA,
    companyB,
    customerA,
    customerB,
    supplier,
    unit,
    alternateUnit,
    badUnit,
    genericMaterial,
    customerMaterial,
  };
}

function partyID(side: SideSpec, fixture: Fixture) {
  return side.key === "sales" ? fixture.customerA.id : fixture.supplier.id;
}

function sideCode(side: SideSpec) {
  return side.key === "sales" ? "S" : "P";
}

function baseQuotationInput(
  side: SideSpec,
  fixture: Fixture,
  quotationNo: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...(quotationNo === null ? {} : { quotationNo }),
    quotationDate: "2026-07-01",
    validUntil: "2026-07-31",
    partyType: side.partyType,
    partyId: partyID(side, fixture),
    companyId: fixture.companyA.id,
    terms: null,
    remarks: `${prefix}${side.label}`,
    ...overrides,
  };
}

async function createFixedItem(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  quotation: Quotation,
  fixture: Fixture,
  idx: number,
  materialID = fixture.genericMaterial.id,
  unitID = fixture.unit.id,
  price = "12.50",
) {
  return createItem(side, tokenHeaders, {
    quotationId: quotation.id,
    idx,
    materialId: materialID,
    unitId: unitID,
    pricingMode: "FIXED",
    price,
    remarks: `${prefix}${side.label}固定价`,
  });
}

async function createTieredItem(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  quotation: Quotation,
  fixture: Fixture,
  idx: number,
  materialID = fixture.genericMaterial.id,
) {
  return createItem(side, tokenHeaders, {
    quotationId: quotation.id,
    idx,
    materialId: materialID,
    unitId: fixture.unit.id,
    pricingMode: "QTY_TIERED",
    price: null,
    taxRate: "0.13",
    remarks: `${prefix}${side.label}梯度价`,
  });
}

async function auditQuotation(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  quotation: Quotation,
) {
  return request<Quotation>(`${side.headPath}/${quotation.id}/audit`, {
    method: "POST",
    headers: tokenHeaders,
  });
}

async function voidQuotation(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  quotation: Quotation,
) {
  return request<Quotation>(`${side.headPath}/${quotation.id}/void`, {
    method: "POST",
    headers: tokenHeaders,
  });
}

async function createAuditedDecoy(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  fixture: Fixture,
  marker: string,
  overrides: Record<string, unknown>,
) {
  const quotation = await createQuotation(
    side,
    tokenHeaders,
    baseQuotationInput(
      side,
      fixture,
      `${prefix}-${sideCode(side)}-${marker}`,
      overrides,
    ),
  );
  const item = await createFixedItem(side, tokenHeaders, quotation, fixture, 1);
  const audited = await auditQuotation(side, tokenHeaders, quotation);
  assert(audited.status === "AUDITED", `${side.label}${marker}报价审核失败`);
  return { quotation: audited, item };
}

async function verifyScope(
  side: SideSpec,
  tokenHeaders: Record<string, string>,
  companyIDs: string[],
  label: string,
) {
  for (const kind of ["heads", "items", "tiers"] as const) {
    const result = await query<RecordID>(side, kind, tokenHeaders, {
      companyId: fk([...fixtureCompanyIDs]),
    });
    const expected = [...active[side.key][kind]]
      .filter(([, companyID]) => companyIDs.includes(companyID))
      .map(([id]) => id)
      .sort();
    assertDeepEqual(
      result.results.map((item) => item.id).sort(),
      expected,
      `${side.label}${label}${kind} CompanyScope`,
    );
  }
}

const adminHeaders = await loginAs(username, password);

try {
  await cleanup();
  await assertCleanupZero();
  const fixture = await createFixture();

  // 六资源 * superadmin/read-only 两态，共 12 份 GridMeta 逐 JSON 语义对拍。
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

  // 自动编号不得借用环境中的既有规则；手填编号不依赖规则。
  const activeRules = (await db`
    SELECT id::text AS id,resource
    FROM sys_numbering_rule
    WHERE resource IN ('sales.quotation','purchase.quotation')
      AND enabled=true
  `) as Array<RecordID & { resource: string }>;
  assert(
    activeRules.length === 0,
    "验收前已存在启用的销售/采购报价编号规则；脚本拒绝覆盖现有配置",
  );
  for (const side of sides) {
    await requestText(
      side.headPath,
      {
        method: "POST",
        headers: adminHeaders,
        body: body(
          baseQuotationInput(side, fixture, null, {
            remarks: `${prefix}${side.label}无规则自动编号`,
          }),
        ),
      },
      409,
    );
  }
  const failedAuto = (await db`
    SELECT
      (SELECT count(*) FROM sal_quotation WHERE remarks=${prefix + "销售无规则自动编号"})::int AS sales,
      (SELECT count(*) FROM pur_quotation WHERE remarks=${prefix + "采购无规则自动编号"})::int AS purchase
  `) as Array<{ sales: number; purchase: number }>;
  assert(
    Number(failedAuto[0]!.sales) === 0 && Number(failedAuto[0]!.purchase) === 0,
    "无规则自动编号失败却落库",
  );

  const main: Record<
    SideKey,
    {
      quotation: Quotation;
      fixed: QuotationItem;
      tiered: QuotationItem;
      tier: QuotationTier;
    }
  > = {} as never;
  for (const side of sides) {
    let quotation = await createQuotation(
      side,
      adminHeaders,
      baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-MAIN`),
    );
    assert(
      quotation.quotationNo === `${prefix}-${sideCode(side)}-MAIN` &&
        quotation.status === "DRAFT" &&
        quotation.currencyId === fixture.currencyA.id &&
        quotation.currency.id === fixture.currencyA.id &&
        quotation.createdById !== null,
      `${side.label}手填编号、默认币种、初始状态或录入人错误`,
    );
    assert(
      quotation.quotationDate === "2026-07-01" &&
        quotation.validUntil === "2026-07-31" &&
        !quotation.quotationDate.includes("T") &&
        !quotation.validUntil.includes("T"),
      `${side.label}日期字段必须为 YYYY-MM-DD`,
    );
    quotation = await request<Quotation>(`${side.headPath}/${quotation.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: body({
        terms: `${prefix}${side.label}条款`,
        remarks: `${prefix}${side.label}已更新`,
      }),
    });
    assert(
      quotation.terms === `${prefix}${side.label}条款` &&
        quotation.remarks === `${prefix}${side.label}已更新`,
      `${side.label}报价头更新失败`,
    );
    quotation = await request<Quotation>(`${side.headPath}/${quotation.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ terms: null }),
    });
    assert(quotation.terms === null, `${side.label}报价头 nullable patch 失败`);

    let fixed = await createFixedItem(
      side,
      adminHeaders,
      quotation,
      fixture,
      1,
      side.key === "purchase"
        ? fixture.customerMaterial.id
        : fixture.genericMaterial.id,
      side.key === "sales" ? fixture.alternateUnit.id : fixture.unit.id,
    );
    assertDecimal(fixed.price, 12.5, `${side.label}固定价`);
    assertDecimal(fixed.taxRate, 0.13, `${side.label}默认税率`);
    assert(
      fixed.quotationDate === "2026-07-01" &&
        fixed.validUntil === "2026-07-31" &&
        fixed.companyId === fixture.companyA.id &&
        fixed.unitName.includes(side.key === "sales" ? "箱" : "个"),
      `${side.label}条目头派生字段、日期或单位快照错误`,
    );
    if (side.key === "purchase") {
      assert(
        fixed.customerPartNo === `${prefix}CP`,
        "采购必须允许客户专属物料并保留客户料号快照",
      );
    }
    fixed = await request<QuotationItem>(`${side.itemPath}/${fixed.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: body({
        idx: 11,
        price: "13.75",
        taxRate: "0.09",
        remarks: `${prefix}${side.label}固定价已更新`,
      }),
    });
    assert(
      fixed.idx === 11 &&
        fixed.remarks === `${prefix}${side.label}固定价已更新`,
      `${side.label}固定价条目更新失败`,
    );
    assertDecimal(fixed.price, 13.75, `${side.label}更新后固定价`);
    assertDecimal(fixed.taxRate, 0.09, `${side.label}更新后税率`);

    let tiered = await createTieredItem(
      side,
      adminHeaders,
      quotation,
      fixture,
      2,
      side.key === "sales"
        ? fixture.customerMaterial.id
        : fixture.genericMaterial.id,
    );
    assert(
      tiered.price === null && tiered.pricingMode === "QTY_TIERED",
      `${side.label}梯度条目必须没有行价`,
    );
    let tier = await createTier(side, adminHeaders, {
      itemId: tiered.id,
      minQty: "10",
      price: "8.50",
    });
    tier = await request<QuotationTier>(`${side.tierPath}/${tier.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ minQty: "12", price: "8.25" }),
    });
    assertDecimal(tier.minQty, 12, `${side.label}更新后起订量`);
    assertDecimal(tier.price, 8.25, `${side.label}更新后档价`);
    const temporaryTier = await createTier(side, adminHeaders, {
      itemId: tiered.id,
      minQty: "100",
      price: "7.00",
    });
    await deleteTier(side, adminHeaders, temporaryTier);
    await requestText(
      `${side.tierPath}/${temporaryTier.id}`,
      { headers: adminHeaders },
      404,
    );
    const temporaryItem = await createFixedItem(
      side,
      adminHeaders,
      quotation,
      fixture,
      99,
      fixture.genericMaterial.id,
      side.key === "sales" ? fixture.unit.id : fixture.alternateUnit.id,
      "1",
    );
    await deleteItem(side, adminHeaders, temporaryItem);
    await requestText(
      `${side.itemPath}/${temporaryItem.id}`,
      { headers: adminHeaders },
      404,
    );
    main[side.key] = { quotation, fixed, tiered, tier };
  }

  // 临时规则必须产生确定编号，删除后不得残留 counter。
  for (const side of sides) {
    const rule = await request<RecordID>(
      "/system/numbering/rules",
      {
        method: "POST",
        headers: adminHeaders,
        body: body({
          resource: side.numberResource,
          name: `${prefix}${side.label}报价编号`,
          segments: [
            {
              type: "text",
              value: `${prefix}-${sideCode(side)}A-`,
            },
            { type: "seq", padding: 3 },
          ],
          perCompany: true,
          enabled: true,
        }),
      },
      201,
    );
    numberingRuleIDs.add(rule.id);
    trackedIDs.add(rule.id);
    const automatic = await createQuotation(
      side,
      adminHeaders,
      baseQuotationInput(side, fixture, null, {
        remarks: `${prefix}${side.label}临时规则自动编号`,
      }),
    );
    assert(
      automatic.quotationNo === `${prefix}-${sideCode(side)}A-001`,
      `${side.label}自动编号=${automatic.quotationNo}`,
    );
    await deleteQuotation(side, adminHeaders, automatic);
    await requestText(
      `/system/numbering/rules/${rule.id}`,
      { method: "DELETE", headers: adminHeaders },
      204,
    );
    numberingRuleIDs.delete(rule.id);
  }

  // 建普通用户时先不授任何报价权限，逐入口证明权限先于 JSON 解码和记录存在性。
  const role = await request<RecordID>(
    "/system/roles",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}READ`,
        name: `${prefix}报价只读`,
        enabled: true,
      }),
    },
    201,
  );
  roleID = role.id;
  trackedIDs.add(role.id);
  await setPermissions(adminHeaders, []);
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
        name: `${prefix}报价只读`,
        roleIds: [role.id],
        companyIds: [fixture.companyA.id],
      }),
    },
    201,
  );
  userID = limited.user.id;
  trackedIDs.add(userID);
  let readHeaders = await loginAs(limited.user.username, limited.password);
  const missingID = crypto.randomUUID();
  for (const side of sides) {
    for (const path of [side.headPath, side.itemPath, side.tierPath]) {
      await requestText(
        `${path}/query`,
        { method: "POST", headers: readHeaders, body: "{" },
        403,
      );
      await requestText(
        path,
        { method: "POST", headers: readHeaders, body: "{" },
        403,
      );
      await requestText(
        `${path}/${missingID}`,
        { method: "PATCH", headers: readHeaders, body: "{" },
        403,
      );
      await requestText(`${path}/${missingID}`, { headers: readHeaders }, 403);
      await requestText(
        `${path}/${missingID}`,
        { method: "DELETE", headers: readHeaders },
        403,
      );
    }
    for (const action of ["audit", "void"]) {
      await requestText(
        `${side.headPath}/${missingID}/${action}`,
        { method: "POST", headers: readHeaders, body: "{" },
        403,
      );
    }
  }

  await setPermissions(
    adminHeaders,
    sides.map((side) => `${side.permission}:read`),
  );
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const resource of resources) {
    const meta = await request<Meta>(`/meta/resources/${resource}`, {
      headers: readHeaders,
    });
    assertDeepEqual(
      meta.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only GridMeta`,
    );
    assertDeepEqual(
      meta.grid.capabilities,
      [],
      `${resource} 只读 capabilities`,
    );
  }

  // 头校验：截止日期、两侧 party 白名单、内部公司 self；合法内部公司可创建删除。
  for (const side of sides) {
    await requestText(
      side.headPath,
      {
        method: "POST",
        headers: adminHeaders,
        body: body(
          baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-BD`, {
            validUntil: "2026-06-30",
          }),
        ),
      },
      400,
    );
    await requestText(
      side.headPath,
      {
        method: "POST",
        headers: adminHeaders,
        body: body(
          baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-BP`, {
            partyType: side.key === "sales" ? "SUPPLIER" : "CUSTOMER",
            partyId:
              side.key === "sales" ? fixture.supplier.id : fixture.customerA.id,
          }),
        ),
      },
      400,
    );
    await requestText(
      side.headPath,
      {
        method: "POST",
        headers: adminHeaders,
        body: body(
          baseQuotationInput(
            side,
            fixture,
            `${prefix}-${sideCode(side)}-SELF`,
            {
              partyType: "COMPANY",
              partyId: fixture.companyA.id,
            },
          ),
        ),
      },
      400,
    );
    const internal = await createQuotation(
      side,
      adminHeaders,
      baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-INT`, {
        partyType: "COMPANY",
        partyId: fixture.companyB.id,
      }),
    );
    if (side.key === "sales") {
      await requestText(
        side.itemPath,
        {
          method: "POST",
          headers: adminHeaders,
          body: body({
            quotationId: internal.id,
            idx: 1,
            materialId: fixture.customerMaterial.id,
            unitId: fixture.unit.id,
            pricingMode: "FIXED",
            price: "1",
          }),
        },
        400,
      );
    }
    await deleteQuotation(side, adminHeaders, internal);
  }

  // 销售客户专属物料须匹配客户；不可用单位拒绝。采购已在主单中证明允许客户专属物料。
  const sales = sides[0]!;
  const mismatch = await createQuotation(
    sales,
    adminHeaders,
    baseQuotationInput(sales, fixture, `${prefix}-SALES-MISMATCH`, {
      partyId: fixture.customerB.id,
    }),
  );
  await requestText(
    sales.itemPath,
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        quotationId: mismatch.id,
        idx: 1,
        materialId: fixture.customerMaterial.id,
        unitId: fixture.unit.id,
        pricingMode: "FIXED",
        price: "1",
      }),
    },
    400,
  );
  await requestText(
    sales.itemPath,
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        quotationId: mismatch.id,
        idx: 1,
        materialId: fixture.genericMaterial.id,
        unitId: fixture.badUnit.id,
        pricingMode: "FIXED",
        price: "1",
      }),
    },
    400,
  );
  await deleteQuotation(sales, adminHeaders, mismatch);

  // 两侧均验证梯度切固定时事务内清档，再切回梯度触发审核门槛。
  for (const side of sides) {
    const current = main[side.key];
    const purgedTierID = current.tier.id;
    current.tiered = await request<QuotationItem>(
      `${side.itemPath}/${current.tiered.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ pricingMode: "FIXED", price: "9.00" }),
      },
    );
    active[side.key].tiers.delete(purgedTierID);
    assert(
      current.tiered.pricingMode === "FIXED" &&
        Number(current.tiered.price) === 9,
      `${side.label}梯度切固定失败`,
    );
    await requestText(
      `${side.tierPath}/${purgedTierID}`,
      { headers: adminHeaders },
      404,
    );
    const purgedRows = (await db`
      SELECT
        (SELECT count(*) FROM sal_quotation_tier WHERE id=${purgedTierID}::uuid)::int AS sal,
        (SELECT count(*) FROM pur_quotation_tier WHERE id=${purgedTierID}::uuid)::int AS pur
    `) as Array<{ sal: number; pur: number }>;
    assert(
      Number(purgedRows[0]!.sal) + Number(purgedRows[0]!.pur) === 0,
      `${side.label}切固定后价格档仍存在`,
    );
    current.tiered = await request<QuotationItem>(
      `${side.itemPath}/${current.tiered.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ pricingMode: "QTY_TIERED", price: null }),
      },
    );
    await requestText(
      `${side.headPath}/${current.quotation.id}/audit`,
      { method: "POST", headers: adminHeaders },
      409,
    );
    current.tier = await createTier(side, adminHeaders, {
      itemId: current.tiered.id,
      minQty: "1",
      price: "9.00",
    });
  }

  // 空报价不得审核，头删除也要走真实 REST。
  for (const side of sides) {
    const empty = await createQuotation(
      side,
      adminHeaders,
      baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-EMPTY`),
    );
    await requestText(
      `${side.headPath}/${empty.id}/audit`,
      { method: "POST", headers: adminHeaders },
      409,
    );
    await deleteQuotation(side, adminHeaders, empty);
    await requestText(
      `${side.headPath}/${empty.id}`,
      { headers: adminHeaders },
      404,
    );
  }

  // 有条目后币种/对手冻结；满足门槛后审核，并冻结头行档。
  for (const side of sides) {
    const current = main[side.key];
    await requestText(
      `${side.headPath}/${current.quotation.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ currencyId: fixture.currencyB.id }),
      },
      409,
    );
    current.quotation = await auditQuotation(
      side,
      adminHeaders,
      current.quotation,
    );
    assert(
      current.quotation.status === "AUDITED" &&
        current.quotation.auditedAt !== null &&
        current.quotation.auditedById !== null,
      `${side.label}审核状态、审核时间或审核人错误`,
    );
    await requestText(
      `${side.headPath}/${current.quotation.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ remarks: `${prefix}审核后禁止更新` }),
      },
      409,
    );
    await requestText(
      `${side.itemPath}/${current.fixed.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ idx: 88 }),
      },
      409,
    );
    await requestText(
      `${side.tierPath}/${current.tier.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: body({ price: "1" }),
      },
      409,
    );
    await requestText(
      `${side.headPath}/${current.quotation.id}/audit`,
      { method: "POST", headers: adminHeaders },
      409,
    );
  }

  // 订单抽屉的隐藏 currencyId 与日期区间筛选：错币、过期、未来报价均不可成为候选。
  for (const side of sides) {
    const wrongCurrency = await createAuditedDecoy(
      side,
      adminHeaders,
      fixture,
      "WC",
      { currencyId: fixture.currencyB.id },
    );
    const expired = await createAuditedDecoy(
      side,
      adminHeaders,
      fixture,
      "EXP",
      { quotationDate: "2026-06-01", validUntil: "2026-06-30" },
    );
    const future = await createAuditedDecoy(
      side,
      adminHeaders,
      fixture,
      "FUT",
      { quotationDate: "2026-08-01", validUntil: "2026-08-31" },
    );
    const candidate = await query<QuotationItem>(side, "items", adminHeaders, {
      quotationStatus: { kind: "enum", values: ["AUDITED"] },
      companyId: fk([fixture.companyA.id]),
      partyType: { kind: "enum", values: [side.partyType] },
      partyId: polyFk(side.partyType, [partyID(side, fixture)]),
      currencyId: fk([fixture.currencyA.id]),
      quotationDate: {
        kind: "date",
        op: "between",
        lte: "2026-07-26",
      },
      validUntil: {
        kind: "date",
        op: "between",
        gte: "2026-07-26",
      },
    });
    assertDeepEqual(
      candidate.results.map((item) => item.id).sort(),
      [main[side.key].fixed.id, main[side.key].tiered.id].sort(),
      `${side.label}有效报价候选`,
    );
    for (const hidden of [
      wrongCurrency.item.id,
      expired.item.id,
      future.item.id,
    ]) {
      assert(
        !candidate.results.some((item) => item.id === hidden),
        `${side.label}错币或日期无效报价泄漏到候选`,
      );
    }
  }

  // 严格状态机 AUDITED -> VOIDED，void 后候选消失。
  for (const side of sides) {
    const current = main[side.key];
    current.quotation = await voidQuotation(
      side,
      adminHeaders,
      current.quotation,
    );
    assert(current.quotation.status === "VOIDED", `${side.label}作废失败`);
    await requestText(
      `${side.headPath}/${current.quotation.id}/void`,
      { method: "POST", headers: adminHeaders },
      409,
    );
    const candidate = await query<QuotationItem>(side, "items", adminHeaders, {
      quotationStatus: { kind: "enum", values: ["AUDITED"] },
      companyId: fk([fixture.companyA.id]),
      partyType: { kind: "enum", values: [side.partyType] },
      partyId: polyFk(side.partyType, [partyID(side, fixture)]),
      currencyId: fk([fixture.currencyA.id]),
      quotationDate: {
        kind: "date",
        op: "between",
        lte: "2026-07-26",
      },
      validUntil: {
        kind: "date",
        op: "between",
        gte: "2026-07-26",
      },
    });
    assert(
      !candidate.results.some(
        (item) => item.quotationId === current.quotation.id,
      ),
      `${side.label}作废报价仍出现在有效候选`,
    );
  }

  // 为 B 公司各建一套头/梯度行/档，用于三资源 single/multi/all/empty scope。
  const other: Record<
    SideKey,
    { quotation: Quotation; item: QuotationItem; tier: QuotationTier }
  > = {} as never;
  for (const side of sides) {
    const quotation = await createQuotation(
      side,
      adminHeaders,
      baseQuotationInput(side, fixture, `${prefix}-${sideCode(side)}-CB`, {
        companyId: fixture.companyB.id,
      }),
    );
    const item = await createTieredItem(
      side,
      adminHeaders,
      quotation,
      fixture,
      1,
    );
    const tier = await createTier(side, adminHeaders, {
      itemId: item.id,
      minQty: "1",
      price: "6",
    });
    other[side.key] = { quotation, item, tier };
  }

  // single：A 可见、B get 隐藏 404。
  await setCompanies(adminHeaders, [fixture.companyA.id]);
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const side of sides) {
    await verifyScope(side, readHeaders, [fixture.companyA.id], "single");
    await requestText(
      `${side.headPath}/${other[side.key].quotation.id}`,
      { headers: readHeaders },
      404,
    );
    await requestText(
      `${side.itemPath}/${other[side.key].item.id}`,
      { headers: readHeaders },
      404,
    );
    await requestText(
      `${side.tierPath}/${other[side.key].tier.id}`,
      { headers: readHeaders },
      404,
    );
  }

  // multi。
  await setCompanies(adminHeaders, [fixture.companyA.id, fixture.companyB.id]);
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const side of sides) {
    await verifyScope(
      side,
      readHeaders,
      [fixture.companyA.id, fixture.companyB.id],
      "multi",
    );
  }

  // allCompanies：清空显式公司并重新登录刷新 actor。
  await setCompanies(adminHeaders, []);
  await db`UPDATE sys_user SET all_companies=true WHERE id=${userID}::uuid`;
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const side of sides) {
    await verifyScope(
      side,
      readHeaders,
      [fixture.companyA.id, fixture.companyB.id],
      "all",
    );
  }

  // 空公司集合 fail-closed，三资源均为 0。
  await db`UPDATE sys_user SET all_companies=false WHERE id=${userID}::uuid`;
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const side of sides) {
    for (const kind of ["heads", "items", "tiers"] as const) {
      const result = await query<RecordID>(side, kind, readHeaders, {
        companyId: fk([fixture.companyA.id, fixture.companyB.id]),
      });
      assert(
        result.count === 0,
        `${side.label}${kind} 空公司集合未 fail-closed`,
      );
    }
  }

  // 六资源直接 CRUD 均有审计；头还须有 audit/void，模式切换须留下 tier purge。
  const auditRows = (await db`
    SELECT resource,record_id::text AS "recordId",action_name AS "actionName"
    FROM sys_audit_log
    WHERE record_id=ANY(${"{" + [...trackedIDs].join(",") + "}"}::uuid[])
      AND resource IN (
        'sal_quotation','sal_quotation_item','sal_quotation_tier',
        'pur_quotation','pur_quotation_item','pur_quotation_tier'
      )
  `) as Array<{ resource: string; recordId: string; actionName: string }>;
  for (const side of sides) {
    const [headResource, itemResource, tierResource] = side.auditResources;
    for (const [resource, actions] of [
      [headResource, ["create", "update", "destroy", "audit", "void"]],
      [itemResource, ["create", "update", "destroy"]],
      [tierResource, ["create", "update", "destroy", "purge"]],
    ] as const) {
      for (const action of actions) {
        assert(
          auditRows.some(
            (row) => row.resource === resource && row.actionName === action,
          ),
          `${side.label}${resource} 缺少 ${action} 审计`,
        );
      }
    }
  }

  const auditCount = auditRows.length;
  await cleanup();
  await assertCleanupZero();
  console.log(
    "quotation REST acceptance ok: meta=12 permissionFirst=34 " +
      "companyScope=single/multi/all/empty salesCRUD=head/item/tier " +
      "purchaseCRUD=head/item/tier numbering=manual/default/reject/auto " +
      `candidates=currency/date auditRows=${auditCount} cleanup=0`,
  );
} finally {
  await cleanup();
  await assertCleanupZero();
  await db.close();
}
