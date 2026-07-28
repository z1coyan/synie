import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const db = new SQL(databaseURL);
const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR220${suffix}`;
const missingID = randomUUID();
const today = "2098-07-26";
const future = "2098-12-31";

type Headers = Record<string, string>;
type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type MetaDocument = { name: string; grid: Record<string, unknown> };
type Fixture = {
  currencyID: string;
  companyA: string;
  companyB: string;
  employeeID: string;
  customerID: string;
  accountBank: string;
  accountCounter: string;
  accountExpense: string;
  accountPayable: string;
  accountBill: string;
  accountSettle: string;
  accountInterest: string;
};
type HTTPResult<T = unknown> = {
  status: number;
  text: string;
  data?: T;
};

const resources = [
  "accBankAccounts",
  "accBankTransactions",
  "accBankImportTemplates",
  "accBankImports",
  "accBankImportItems",
  "accBankReconciliations",
  "accVatInvoices",
  "accExpenseReports",
  "accExpenseReportItems",
  "accBills",
  "accBillTransactions",
  "accBillHoldings",
] as const;

const resourcePaths = [
  "bank-accounts",
  "bank-transactions",
  "bank-import-templates",
  "bank-imports",
  "bank-import-items",
  "bank-reconciliations",
  "vat-invoices",
  "expense-reports",
  "expense-report-items",
  "bills",
  "bill-transactions",
  "bill-holdings",
] as const;

const readPermissions = [
  "acc.bank_account:read",
  "acc.bank_transaction:read",
  "acc.bank_import_template:read",
  "acc.vat_invoice:read",
  "acc.expense_report:read",
  "acc.bill:read",
  "acc.bill_transaction:read",
  "acc.bill_holding:read",
  "base.company:read",
  "base.account:read",
  "sys.file:read",
  "sys.user:read",
  "sales.customer:read",
  "purchase.supplier:read",
  "sales.reconciliation:read",
  "purchase.reconciliation:read",
] as const;

const ids = new Set<string>();
const fileIDs = new Set<string>();
const numberingRuleIDs = new Set<string>();
let readerRoleID: string | null = null;
let readerUserID: string | null = null;
let noCompanyRoleID: string | null = null;
let noCompanyUserID: string | null = null;
let importRoleID: string | null = null;
let importUserID: string | null = null;
let storageID: string | null = null;
let previousStorageID: string | null = null;
let graphqlCalls = 0;
let metaChecks = 0;
let permissionChecks = 0;
let unavailableChecks = 0;
let wireChecks = 0;
let stateChecks = 0;
let scopeChecks = 0;
let auditChecks = 0;
let concurrencyChecks = 0;
let cleanupCount = -1;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRuleFailure(status: number): boolean {
  return status === 400 || status === 409 || status === 422;
}

function body(value: unknown): string {
  return JSON.stringify(value);
}

function authHeaders(token: string): Headers {
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

function same(actual: unknown, expected: unknown, label: string): void {
  const got = JSON.stringify(stable(actual));
  const want = JSON.stringify(stable(expected));
  assert(got === want, `${label} 不一致\nactual=${got}\nexpected=${want}`);
}

async function rawRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (new URL(baseURL + path).pathname.endsWith("/graphql")) graphqlCalls++;
  return fetch(baseURL + path, init);
}

async function attempt<T>(
  path: string,
  init: RequestInit = {},
): Promise<HTTPResult<T>> {
  const response = await rawRequest(path, init);
  const text = await response.text();
  let data: T | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // Error responses are allowed to remain plain text.
    }
  }
  return { status: response.status, text, data };
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expected = 200,
): Promise<string> {
  const result = await attempt(path, init);
  assert(
    result.status === expected,
    `${init.method ?? "GET"} ${path}: ${result.status}, want ${expected}, ${result.text}`,
  );
  return result.text;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expected = 200,
): Promise<T> {
  const text = await requestText(path, init, expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function login(name: string, secret: string): Promise<Headers> {
  const result = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ username: name, password: secret }),
  });
  return authHeaders(result.token);
}

async function snapshot(
  resource: string,
  actor: "superadmin" | "read-only",
): Promise<unknown> {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.20",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

async function query<T>(
  headers: Headers,
  path: string,
  filter: Record<string, unknown> = {},
  sort?: { column: string; direction: "ascending" | "descending" },
): Promise<List<T>> {
  return request<List<T>>(path, {
    method: "POST",
    headers,
    body: body({ limit: 200, offset: 0, filter, sort }),
  });
}

async function expectPermissionFirst(
  path: string,
  init: RequestInit,
): Promise<void> {
  await requestText(path, init, 403);
  permissionChecks++;
}

async function expectUnavailable(
  path: string,
  init: RequestInit,
): Promise<void> {
  const result = await attempt(path, init);
  assert(
    result.status === 404 || result.status === 405,
    `${init.method ?? "GET"} ${path} 应保持内部，实际 ${result.status}: ${result.text}`,
  );
  unavailableChecks++;
}

function requireKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  same(Object.keys(row).sort(), [...keys].sort(), `${label} wire keys`);
  wireChecks++;
}

function requireDecimal(
  row: Record<string, unknown>,
  key: string,
  nullable = false,
): void {
  const value = row[key];
  assert(
    typeof value === "string" || (nullable && value === null),
    `${key} 必须保持 Decimal string${nullable ? "/null" : ""}: ${JSON.stringify(value)}`,
  );
  wireChecks++;
}

function requireUpperEnum(
  row: Record<string, unknown>,
  key: string,
  values: readonly string[],
): void {
  assert(
    typeof row[key] === "string" && values.includes(String(row[key])),
    `${key} enum wire 错误: ${JSON.stringify(row[key])}`,
  );
  wireChecks++;
}

function fixtureIDs(): Fixture {
  return {
    currencyID: randomUUID(),
    companyA: randomUUID(),
    companyB: randomUUID(),
    employeeID: randomUUID(),
    customerID: randomUUID(),
    accountBank: randomUUID(),
    accountCounter: randomUUID(),
    accountExpense: randomUUID(),
    accountPayable: randomUUID(),
    accountBill: randomUUID(),
    accountSettle: randomUUID(),
    accountInterest: randomUUID(),
  };
}

async function createFixture(fixture: Fixture): Promise<void> {
  await db.begin(async (tx) => {
    await tx`INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES(${fixture.currencyID}::uuid,${prefix + "验收币"},${"Q" + suffix},'¤',true)`;
    await tx`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES
        (${fixture.companyA}::uuid,${prefix + "A"},${prefix + "甲公司"},${prefix + "甲"},${fixture.currencyID}::uuid),
        (${fixture.companyB}::uuid,${prefix + "B"},${prefix + "乙公司"},${prefix + "乙"},${fixture.currencyID}::uuid)`;
    await tx`INSERT INTO hr_employees(id,code,name)
      VALUES(${fixture.employeeID}::uuid,${prefix + "E1"},${prefix + "验收员工"})`;
    await tx`INSERT INTO sal_customers(id,code,name,short_name)
      VALUES(
        ${fixture.customerID}::uuid,${prefix + "C1"},${prefix + "验收客户"},
        ${prefix + "客户"}
      )`;
    const accounts = [
      [fixture.accountBank, "1002", "银行存款", null],
      [fixture.accountCounter, "6001", "对方科目", null],
      [fixture.accountExpense, "6601", "费用科目", "management_expense"],
      [fixture.accountPayable, "2241", "其他应付款", "other_payable"],
      [fixture.accountBill, "1121", "应收票据", null],
      [fixture.accountSettle, "1122", "结算科目", null],
      [fixture.accountInterest, "6603", "贴现利息", "financial_expense"],
    ] as const;
    for (const [id, code, name, role] of accounts) {
      await tx`INSERT INTO bas_account(
        id,code,name,direction,is_group,active,company_id,currency_id,role
      ) VALUES(
        ${id}::uuid,${code + suffix},${prefix + name},'debit',false,true,
        ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,${role}
      )`;
    }
  });
}

async function createRoleUser(
  admin: Headers,
  code: string,
  permissions: readonly string[],
  companyIDs: string[],
): Promise<{ roleID: string; userID: string; headers: Headers }> {
  const role = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({
        code: `${prefix}${code}`,
        name: `${prefix}${code}`,
        enabled: true,
      }),
    },
    201,
  );
  ids.add(role.id);
  await request(`/system/roles/${role.id}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({ permissions }),
  });
  const created = await request<{
    user: Row & { username: string };
    password: string;
  }>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}${code.toLowerCase()}`,
        name: `${prefix}${code}`,
        roleIds: [role.id],
        companyIds: companyIDs,
      }),
    },
    201,
  );
  ids.add(created.user.id);
  return {
    roleID: role.id,
    userID: created.user.id,
    headers: await login(created.user.username, created.password),
  };
}

async function ensureNumberingRule(
  admin: Headers,
  resource: string,
  marker: string,
): Promise<void> {
  const rows = (await db`
    SELECT count(*)::int AS count
      FROM sys_numbering_rule
     WHERE resource=${resource} AND enabled=true
  `) as Array<{ count: number }>;
  if (Number(rows[0]?.count ?? 0) > 0) return;
  const rule = await request<Row>(
    "/system/numbering/rules",
    {
      method: "POST",
      headers: admin,
      body: body({
        resource,
        name: `${prefix}${marker}编号`,
        segments: [
          { type: "text", value: `${prefix}${marker}-` },
          { type: "seq", padding: 4 },
        ],
        perCompany: true,
        enabled: true,
      }),
    },
    201,
  );
  numberingRuleIDs.add(rule.id);
  ids.add(rule.id);
}

async function setupStorage(): Promise<void> {
  const previous = (await db`
    SELECT id::text AS id FROM sys_storage WHERE is_default=true LIMIT 1
  `) as Array<{ id: string }>;
  previousStorageID = previous[0]?.id ?? null;
  const inserted = (await db.begin(async (tx) => {
    await tx`UPDATE sys_storage SET is_default=false WHERE is_default=true`;
    return tx`INSERT INTO sys_storage(name,label,kind,root,is_default)
      VALUES(
        ${prefix.toLowerCase()},${prefix + "验收存储"},'local',
        ${`/tmp/${prefix.toLowerCase()}-files`},true
      ) RETURNING id::text AS id`;
  })) as Array<{ id: string }>;
  storageID = inserted[0]!.id;
}

async function upload(
  headers: Headers,
  filename: string,
  contentType: string,
  content: Uint8Array,
): Promise<{ id: string; sha256: string }> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: contentType }), filename);
  const response = await rawRequest("/files", {
    method: "POST",
    headers: { Authorization: headers.Authorization },
    body: form,
  });
  const text = await response.text();
  assert(response.status === 201, `上传 ${filename}: ${response.status} ${text}`);
  const result = JSON.parse(text) as {
    file: { id: string; sha256?: string };
  };
  fileIDs.add(result.file.id);
  return {
    id: result.file.id,
    sha256:
      result.file.sha256 ??
      createHash("sha256").update(content).digest("hex"),
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = encoder.encode(name);
    const content = encoder.encode(value);
    const checksum = crc32(content);
    const local = new Uint8Array(30 + filename.length + content.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, content.length, true);
    localView.setUint32(22, content.length, true);
    localView.setUint16(26, filename.length, true);
    local.set(filename, 30);
    local.set(content, 30 + filename.length);
    locals.push(local);

    const central = new Uint8Array(46 + filename.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, content.length, true);
    centralView.setUint32(24, content.length, true);
    centralView.setUint16(28, filename.length, true);
    centralView.setUint32(42, offset, true);
    central.set(filename, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, value) => sum + value.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, centrals.length, true);
  endView.setUint16(10, centrals.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const section of [...locals, ...centrals, end]) {
    result.set(section, cursor);
    cursor += section.length;
  }
  return result;
}

function xlsxBytes(): Uint8Array {
  const cell = (ref: string, value: string) =>
    `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  return zipStored({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml":
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1">${cell("A1", "时间")}${cell("B1", "金额")}${cell("C1", "余额")}${cell("D1", "摘要")}</row>` +
      `<row r="2">${cell("A2", "2098-07-01 10:30:00")}${cell("B2", "1,234.56")}${cell("C2", "5,000.00")}${cell("D2", prefix + "收入")}</row>` +
      `<row r="3">${cell("A3", "2098-07-02 08:00:00")}${cell("B3", "-88")}${cell("D3", prefix + "支出")}</row>` +
      `</sheetData></worksheet>`,
  });
}

async function createJournal(
  admin: Headers,
  fixture: Fixture,
  amount: string,
  bankSide: "debit" | "credit",
): Promise<Row> {
  const journal = await request<Row>(
    "/accounting/gl-journals",
    {
      method: "POST",
      headers: admin,
      body: body({
        voucherNo: `${prefix}J${ids.size}`,
        date: today,
        companyId: fixture.companyA,
        remarks: `${prefix}对账凭证`,
      }),
    },
    201,
  );
  ids.add(journal.id);
  const bankLine = await request<Row>(
    "/accounting/gl-journal-lines",
    {
      method: "POST",
      headers: admin,
      body: body({
        journalId: journal.id,
        idx: 1,
        accountId: fixture.accountBank,
        debit: bankSide === "debit" ? amount : "0",
        credit: bankSide === "credit" ? amount : "0",
        remarks: `${prefix}银行方向`,
      }),
    },
    201,
  );
  ids.add(bankLine.id);
  const counterLine = await request<Row>(
    "/accounting/gl-journal-lines",
    {
      method: "POST",
      headers: admin,
      body: body({
        journalId: journal.id,
        idx: 2,
        accountId: fixture.accountCounter,
        debit: bankSide === "credit" ? amount : "0",
        credit: bankSide === "debit" ? amount : "0",
        remarks: `${prefix}对方方向`,
      }),
    },
    201,
  );
  ids.add(counterLine.id);
  return request<Row>(
    `/accounting/gl-journals/${journal.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
}

async function assertMeta(
  admin: Headers,
  reader: Headers,
): Promise<void> {
  for (const resource of resources) {
    const superDocument = await request<MetaDocument>(
      `/meta/resources/${resource}`,
      { headers: admin },
    );
    same(
      superDocument.grid,
      await snapshot(resource, "superadmin"),
      `${resource} superadmin GridMeta`,
    );
    metaChecks++;
    const readDocument = await request<MetaDocument>(
      `/meta/resources/${resource}`,
      { headers: reader },
    );
    same(
      readDocument.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only GridMeta`,
    );
    metaChecks++;
  }
}

async function assertPermissionSurface(reader: Headers): Promise<void> {
  const malformed = "{";
  const cases: Array<[string, string]> = [
    ["POST", "/finance/bank-accounts"],
    ["PATCH", `/finance/bank-accounts/${missingID}`],
    ["DELETE", `/finance/bank-accounts/${missingID}`],
    ["POST", "/finance/bank-transactions"],
    ["PATCH", `/finance/bank-transactions/${missingID}`],
    ["DELETE", `/finance/bank-transactions/${missingID}`],
    ["POST", "/finance/bank-import-templates"],
    ["PATCH", `/finance/bank-import-templates/${missingID}`],
    ["DELETE", `/finance/bank-import-templates/${missingID}`],
    ["POST", "/finance/bank-imports"],
    ["DELETE", `/finance/bank-imports/${missingID}`],
    ["POST", `/finance/bank-imports/${missingID}/import`],
    ["PATCH", `/finance/bank-import-items/${missingID}`],
    ["DELETE", `/finance/bank-import-items/${missingID}`],
    ["POST", "/finance/bank-reconciliations"],
    ["DELETE", `/finance/bank-reconciliations/${missingID}`],
    ["POST", "/finance/bank-reconciliations/quick-create"],
    ["POST", "/finance/vat-invoices"],
    ["PATCH", `/finance/vat-invoices/${missingID}`],
    ["DELETE", `/finance/vat-invoices/${missingID}`],
    ["POST", `/finance/vat-invoices/${missingID}/audit`],
    ["POST", `/finance/vat-invoices/${missingID}/void`],
    ["POST", `/finance/vat-invoices/${missingID}/reverse`],
    ["POST", "/finance/vat-invoices/ocr"],
    ["POST", "/finance/expense-reports"],
    ["PATCH", `/finance/expense-reports/${missingID}`],
    ["DELETE", `/finance/expense-reports/${missingID}`],
    ["POST", `/finance/expense-reports/${missingID}/audit`],
    ["POST", `/finance/expense-reports/${missingID}/void`],
    ["POST", "/finance/expense-report-items"],
    ["PATCH", `/finance/expense-report-items/${missingID}`],
    ["DELETE", `/finance/expense-report-items/${missingID}`],
    ["PATCH", `/finance/bills/${missingID}`],
    ["DELETE", `/finance/bills/${missingID}`],
    ["POST", "/finance/bill-transactions"],
    ["PATCH", `/finance/bill-transactions/${missingID}`],
    ["DELETE", `/finance/bill-transactions/${missingID}`],
    ["POST", `/finance/bill-transactions/${missingID}/audit`],
    ["POST", `/finance/bill-transactions/${missingID}/void`],
    ["POST", "/finance/bill-transactions/ocr"],
  ];
  assert(cases.length === 40, `公开 mutation 应为 40，实际 ${cases.length}`);
  for (const [method, path] of cases) {
    await expectPermissionFirst(path, {
      method,
      headers: reader,
      ...(method === "DELETE" ? {} : { body: malformed }),
    });
  }
}

async function assertInternalSurface(admin: Headers): Promise<void> {
  for (const [path, init] of [
    [
      `/finance/bank-transactions/${missingID}/refresh-reconcile`,
      { method: "POST", headers: admin, body: "{}" },
    ],
    [
      "/finance/bank-import-items",
      { method: "POST", headers: admin, body: "{}" },
    ],
    [
      `/finance/bank-import-items/${missingID}/link-transaction`,
      { method: "POST", headers: admin, body: "{}" },
    ],
    ["/finance/bills/register", { method: "POST", headers: admin, body: "{}" }],
    [
      "/finance/bill-holdings/rebuild",
      { method: "POST", headers: admin, body: "{}" },
    ],
    [
      `/finance/bill-holdings/${missingID}`,
      { method: "DELETE", headers: admin },
    ],
  ] as Array<[string, RequestInit]>) {
    await expectUnavailable(path, init);
  }
}

async function createBankingFacts(
  admin: Headers,
  fixture: Fixture,
): Promise<{
  accountA: Row;
  accountB: Row;
  transactionA: Row;
  transactionB: Row;
  template: Row;
}> {
  const accountA = await request<Row>(
    "/finance/bank-accounts",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        currencyId: fixture.currencyID,
        accountId: fixture.accountBank,
        alias: `${prefix}基本户`,
        bankName: `${prefix}银行`,
        branchName: null,
        holderName: `${prefix}甲公司`,
        accountNo: `${prefix}001`,
        active: true,
        note: null,
      }),
    },
    201,
  );
  ids.add(accountA.id);
  const accountB = await request<Row>(
    "/finance/bank-accounts",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyB,
        currencyId: fixture.currencyID,
        alias: `${prefix}他司户`,
        bankName: `${prefix}银行`,
        holderName: `${prefix}乙公司`,
        accountNo: `${prefix}002`,
      }),
    },
    201,
  );
  ids.add(accountB.id);
  const transactionA = await request<Row>(
    "/finance/bank-transactions",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: accountA.id,
        occurredAt: `${today}T02:30:00Z`,
        income: "1234.56",
        expense: null,
        balance: null,
        summary: `${prefix}收入流水`,
        note: null,
      }),
    },
    201,
  );
  ids.add(transactionA.id);
  const transactionB = await request<Row>(
    "/finance/bank-transactions",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyB,
        bankAccountId: accountB.id,
        occurredAt: `${today}T03:30:00Z`,
        income: null,
        expense: "88",
        summary: `${prefix}他司流水`,
      }),
    },
    201,
  );
  ids.add(transactionB.id);
  const invalidSides = await attempt("/finance/bank-transactions", {
    method: "POST",
    headers: admin,
    body: body({
      companyId: fixture.companyA,
      bankAccountId: accountA.id,
      occurredAt: `${today}T04:30:00Z`,
      income: "1",
      expense: "1",
    }),
  });
  assert(
    isRuleFailure(invalidSides.status),
    `流水单边金额守卫未生效: ${invalidSides.status} ${invalidSides.text}`,
  );
  stateChecks++;
  const template = await request<Row>(
    "/finance/bank-import-templates",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: accountA.id,
        name: `${prefix}XLSX模板`,
        startRow: 2,
        datetimeCol: " a ",
        datetimeFormat: "YMD_DASH_HMS",
        amountCol: " b ",
        balanceCol: "c",
        summaryCol: "d",
      }),
    },
    201,
  );
  ids.add(template.id);
  assert(
    template.datetimeCol === "A" &&
      template.amountCol === "B" &&
      template.balanceCol === "C",
    `模板列号未 trim+uppercase: ${JSON.stringify(template)}`,
  );
  stateChecks++;
  return { accountA, accountB, transactionA, transactionB, template };
}

async function assertScopes(
  reader: Headers,
  fixture: Fixture,
  facts: {
    accountA: Row;
    accountB: Row;
    transactionA: Row;
    transactionB: Row;
  },
): Promise<void> {
  const accounts = await query<Row>(reader, "/finance/bank-accounts/query");
  assert(
    accounts.results.some((row) => row.id === facts.accountA.id) &&
      !accounts.results.some((row) => row.id === facts.accountB.id),
    "BankAccount CompanyScope 正反失败",
  );
  await request<Row>(`/finance/bank-accounts/${facts.accountA.id}`, {
    headers: reader,
  });
  await requestText(
    `/finance/bank-accounts/${facts.accountB.id}`,
    { headers: reader },
    404,
  );
  const transactions = await query<Row>(
    reader,
    "/finance/bank-transactions/query",
  );
  assert(
    transactions.results.some((row) => row.id === facts.transactionA.id) &&
      !transactions.results.some((row) => row.id === facts.transactionB.id),
    "BankTransaction CompanyScope 正反失败",
  );
  scopeChecks += 4;
  const noCompany = (await db`
    SELECT count(*)::int AS count
      FROM sys_user_company
     WHERE user_id=${readerUserID}::uuid
  `) as Array<{ count: number }>;
  assert(Number(noCompany[0]!.count) === 1, "只读 actor 公司绑定异常");
  assert(fixture.companyA !== fixture.companyB, "验收公司必须不同");
}

async function assertImportLifecycle(
  admin: Headers,
  importer: Headers,
  fixture: Fixture,
  account: Row,
  template: Row,
): Promise<{ batch: Row; item: Row }> {
  const xlsx = await upload(
    admin,
    `${prefix}-bank.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsxBytes(),
  );
  const batch = await request<Row>(
    "/finance/bank-imports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: account.id,
        templateId: template.id,
        fileId: xlsx.id,
      }),
    },
    201,
  );
  ids.add(batch.id);
  assert(
    batch.status === "PARSED" &&
      batch.error === null &&
      batch.itemCount === 2 &&
      batch.errorCount === 0,
    `xlsx 解析批次错误: ${JSON.stringify(batch)}`,
  );
  stateChecks += 4;
  const items = await query<Row>(
    admin,
    "/finance/bank-import-items/query",
    { importId: { kind: "fk", op: "in", values: [batch.id] } },
    { column: "rowNo", direction: "ascending" },
  );
  assert(items.count === 2, `xlsx itemCount=${items.count}`);
  const item = items.results[0]!;
  ids.add(item.id);
  requireDecimal(item, "income", true);
  requireDecimal(item, "expense", true);
  requireDecimal(item, "balance", true);
  assert(item.transactionId === null, "parsed item transactionId 必须为 null");
  wireChecks++;

  const duplicate = await attempt("/finance/bank-imports", {
    method: "POST",
    headers: admin,
    body: body({
      companyId: fixture.companyA,
      bankAccountId: account.id,
      templateId: template.id,
      fileId: xlsx.id,
    }),
  });
  assert(
    isRuleFailure(duplicate.status),
    `相同 SHA 防重失败: ${duplicate.status} ${duplicate.text}`,
  );
  stateChecks++;

  const depth = await attempt(`/finance/bank-imports/${batch.id}/import`, {
    method: "POST",
    headers: importer,
  });
  assert(
    depth.status === 403,
    `导入纵深 create 权限未执法: ${depth.status} ${depth.text}`,
  );
  stateChecks++;

  const [racingImport, racingUpdate] = await Promise.all([
    attempt<Row>(`/finance/bank-imports/${batch.id}/import`, {
      method: "POST",
      headers: admin,
    }),
    attempt<Row>(`/finance/bank-import-items/${item.id}`, {
      method: "PATCH",
      headers: admin,
      body: body({ summary: `${prefix}并发修订` }),
    }),
  ]);
  assert(
    racingImport.status === 200 &&
      (racingUpdate.status === 200 || isRuleFailure(racingUpdate.status)),
    `父批次锁未串行 import/item: import=${racingImport.status}, update=${racingUpdate.status}`,
  );
  const afterImportedUpdate = await attempt(
    `/finance/bank-import-items/${item.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ summary: `${prefix}终态后禁止修改` }),
    },
  );
  assert(
    isRuleFailure(afterImportedUpdate.status),
    `IMPORTED 父批次仍可修改 item: ${afterImportedUpdate.status} ${afterImportedUpdate.text}`,
  );
  concurrencyChecks++;
  const imported = await request<Row>(
    `/finance/bank-imports/${batch.id}`,
    { headers: admin },
  );
  assert(
    imported.status === "IMPORTED" &&
      imported.importedAt !== null &&
      imported.importedById !== null,
    `批次导入终态错误: ${JSON.stringify(imported)}`,
  );
  stateChecks += 3;

  const fake = await upload(
    admin,
    `${prefix}-fake.xls`,
    "application/vnd.ms-excel",
    new TextEncoder().encode("<html>not excel</html>"),
  );
  const failed = await request<Row>(
    "/finance/bank-imports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: account.id,
        templateId: template.id,
        fileId: fake.id,
      }),
    },
    201,
  );
  ids.add(failed.id);
  assert(
    failed.status === "FAILED" &&
      typeof failed.error === "string" &&
      String(failed.error).includes("xlsx/xls"),
    `FAILED 留痕/可读错误错误: ${JSON.stringify(failed)}`,
  );
  stateChecks += 2;

  const xlsTemplate = await request<Row>(
    "/finance/bank-import-templates",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: account.id,
        name: `${prefix}XLS模板`,
        startRow: 2,
        dateCol: "A",
        dateFormat: "YMD_DASH",
        timeCol: "B",
        timeFormat: "HMS",
        incomeCol: "C",
        expenseCol: "D",
        balanceCol: "E",
        counterpartyNameCol: "F",
        summaryCol: "G",
      }),
    },
    201,
  );
  ids.add(xlsTemplate.id);
  const xls = await upload(
    admin,
    `${prefix}-bank.xls`,
    "application/vnd.ms-excel",
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "backend",
        "apps",
        "synie_core",
        "test",
        "support",
        "fixtures",
        "bank_import_sample.xls",
      ),
    ),
  );
  const xlsBatch = await request<Row>(
    "/finance/bank-imports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: account.id,
        templateId: xlsTemplate.id,
        fileId: xls.id,
      }),
    },
    201,
  );
  ids.add(xlsBatch.id);
  assert(
    xlsBatch.status === "PARSED" && xlsBatch.itemCount === 3,
    `真实 BIFF8 xls 解析失败: ${JSON.stringify(xlsBatch)}`,
  );
  stateChecks++;

  const rollbackAccount = await request<Row>(
    "/finance/bank-accounts",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        currencyId: fixture.currencyID,
        alias: `${prefix}回滚户`,
        bankName: `${prefix}银行`,
        holderName: `${prefix}甲公司`,
        accountNo: `${prefix}ROLLBACK`,
      }),
    },
    201,
  );
  ids.add(rollbackAccount.id);
  const rollbackTemplate = await request<Row>(
    "/finance/bank-import-templates",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: rollbackAccount.id,
        name: `${prefix}回滚模板`,
        datetimeCol: "A",
        datetimeFormat: "YMD_DASH_HMS",
        amountCol: "B",
      }),
    },
    201,
  );
  ids.add(rollbackTemplate.id);
  const rollbackFile = await upload(
    admin,
    `${prefix}-rollback.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsxBytes(),
  );
  const rollbackBatch = await request<Row>(
    "/finance/bank-imports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        bankAccountId: rollbackAccount.id,
        templateId: rollbackTemplate.id,
        fileId: rollbackFile.id,
      }),
    },
    201,
  );
  ids.add(rollbackBatch.id);
  await request<Row>(
    `/finance/bank-accounts/${rollbackAccount.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ active: false }),
    },
  );
  const before = await query<Row>(
    admin,
    "/finance/bank-transactions/query",
    { bankAccountId: { kind: "fk", op: "in", values: [rollbackAccount.id] } },
  );
  const rolledBack = await attempt(
    `/finance/bank-imports/${rollbackBatch.id}/import`,
    { method: "POST", headers: admin },
  );
  assert(
    isRuleFailure(rolledBack.status),
    `停用账户导入应失败: ${rolledBack.status} ${rolledBack.text}`,
  );
  const after = await query<Row>(
    admin,
    "/finance/bank-transactions/query",
    { bankAccountId: { kind: "fk", op: "in", values: [rollbackAccount.id] } },
  );
  assert(
    after.count === before.count,
    `整批导入失败后出现部分流水: before=${before.count} after=${after.count}`,
  );
  const stillParsed = await request<Row>(
    `/finance/bank-imports/${rollbackBatch.id}`,
    { headers: admin },
  );
  assert(stillParsed.status === "PARSED", "整批回滚后批次必须仍为 PARSED");
  stateChecks += 3;
  return { batch: imported, item };
}

async function assertReconciliation(
  admin: Headers,
  fixture: Fixture,
  account: Row,
  transaction: Row,
): Promise<Row> {
  const journal = await createJournal(admin, fixture, "1000", "debit");
  const remaining = await request<{ amount: string }>(
    `/finance/bank-reconciliations/remaining?bankTransactionId=${transaction.id}&journalId=${journal.id}`,
    { headers: admin },
  );
  assert(remaining.amount === "1000", `remaining=${remaining.amount}, want 1000`);
  requireDecimal(remaining, "amount");
  const reconciliation = await request<Row>(
    "/finance/bank-reconciliations",
    {
      method: "POST",
      headers: admin,
      body: body({
        bankTransactionId: transaction.id,
        journalId: journal.id,
        amount: "1000",
      }),
    },
    201,
  );
  ids.add(reconciliation.id);
  const partially = await request<Row>(
    `/finance/bank-transactions/${transaction.id}`,
    { headers: admin },
  );
  assert(
    partially.reconciledAmount === "1000" &&
      partially.unreconciledAmount === "234.56" &&
      partially.reconcileStatus === "PARTIAL",
    `对账派生列错误: ${JSON.stringify(partially)}`,
  );
  stateChecks += 3;
  for (const [label, operation] of [
    [
      "缩额",
      () =>
        attempt(`/finance/bank-transactions/${transaction.id}`, {
          method: "PATCH",
          headers: admin,
          body: body({ income: "999" }),
        }),
    ],
    [
      "换边",
      () =>
        attempt(`/finance/bank-transactions/${transaction.id}`, {
          method: "PATCH",
          headers: admin,
          body: body({ income: null, expense: "1234.56" }),
        }),
    ],
    [
      "删除流水",
      () =>
        attempt(`/finance/bank-transactions/${transaction.id}`, {
          method: "DELETE",
          headers: admin,
        }),
    ],
    [
      "账户解绑科目",
      () =>
        attempt(`/finance/bank-accounts/${account.id}`, {
          method: "PATCH",
          headers: admin,
          body: body({ accountId: null }),
        }),
    ],
    [
      "凭证取消",
      () =>
        attempt(`/accounting/gl-journals/${journal.id}/cancel`, {
          method: "POST",
          headers: admin,
        }),
    ],
  ] as const) {
    const result = await operation();
    assert(
      isRuleFailure(result.status),
      `对账反向守卫「${label}」失效: ${result.status} ${result.text}`,
    );
    stateChecks++;
  }
  const wrongJournal = await createJournal(admin, fixture, "100", "credit");
  const wrongDirection = await attempt("/finance/bank-reconciliations", {
    method: "POST",
    headers: admin,
    body: body({
      bankTransactionId: transaction.id,
      journalId: wrongJournal.id,
      amount: "1",
    }),
  });
  assert(
    isRuleFailure(wrongDirection.status),
    `对账方向守卫失效: ${wrongDirection.status} ${wrongDirection.text}`,
  );
  stateChecks++;
  const overCapacity = await attempt("/finance/bank-reconciliations", {
    method: "POST",
    headers: admin,
    body: body({
      bankTransactionId: transaction.id,
      journalId: journal.id,
      amount: "234.57",
    }),
  });
  assert(
    isRuleFailure(overCapacity.status),
    `双侧容量守卫失效: ${overCapacity.status} ${overCapacity.text}`,
  );
  stateChecks++;
  await requestText(
    `/finance/bank-reconciliations/${reconciliation.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  const refreshed = await request<Row>(
    `/finance/bank-transactions/${transaction.id}`,
    { headers: admin },
  );
  assert(
    refreshed.reconciledAmount === "0" &&
      refreshed.unreconciledAmount === "1234.56" &&
      refreshed.reconcileStatus === "UNRECONCILED",
    `解除对账刷新错误: ${JSON.stringify(refreshed)}`,
  );
  stateChecks += 3;

  const quick = await request<Row>(
    "/finance/bank-reconciliations/quick-create",
    {
      method: "POST",
      headers: admin,
      body: body({
        bankTransactionId: transaction.id,
        counterAccountId: fixture.accountCounter,
        amount: "100",
        summary: `${prefix}快速对账`,
        postingDate: today,
      }),
    },
    201,
  );
  ids.add(quick.id);
  const quickFacts = (await db`
    SELECT
      j.status,
      count(DISTINCT l.id)::int AS lines,
      count(DISTINCT e.id)::int AS entries
    FROM acc_bank_reconciliation r
    JOIN acc_gl_journal j ON j.id=r.journal_id
    LEFT JOIN acc_gl_journal_line l ON l.journal_id=j.id
    LEFT JOIN acc_gl_entry e ON e.voucher_type='acc.gl_journal'
      AND e.voucher_id=j.id AND NOT e.is_cancelled
    WHERE r.id=${quick.id}::uuid
    GROUP BY j.status
  `) as Array<{ status: string; lines: number; entries: number }>;
  assert(
    quickFacts[0]?.status.toUpperCase() === "AUDITED" &&
      Number(quickFacts[0]?.lines) === 2 &&
      Number(quickFacts[0]?.entries) === 2,
    `quick GL B/C/D 不完整: ${JSON.stringify(quickFacts)}`,
  );
  stateChecks += 3;
  const beforeAtomic = (await db`
    SELECT
      (SELECT count(*) FROM acc_gl_journal WHERE remarks=${prefix + "原子失败"})::int AS journals,
      (SELECT count(*) FROM acc_bank_reconciliation r
        JOIN acc_gl_journal j ON j.id=r.journal_id
       WHERE j.remarks=${prefix + "原子失败"})::int AS reconciliations
  `) as Array<{ journals: number; reconciliations: number }>;
  const quickFailure = await attempt(
    "/finance/bank-reconciliations/quick-create",
    {
      method: "POST",
      headers: admin,
      body: body({
        bankTransactionId: transaction.id,
        counterAccountId: fixture.accountBank,
        amount: "1",
        summary: `${prefix}原子失败`,
        postingDate: today,
      }),
    },
  );
  assert(
    isRuleFailure(quickFailure.status),
    `quick 同科目应失败: ${quickFailure.status} ${quickFailure.text}`,
  );
  const afterAtomic = (await db`
    SELECT
      (SELECT count(*) FROM acc_gl_journal WHERE remarks=${prefix + "原子失败"})::int AS journals,
      (SELECT count(*) FROM acc_bank_reconciliation r
        JOIN acc_gl_journal j ON j.id=r.journal_id
       WHERE j.remarks=${prefix + "原子失败"})::int AS reconciliations
  `) as Array<{ journals: number; reconciliations: number }>;
  same(afterAtomic, beforeAtomic, "quick create 失败必须整体回滚");
  stateChecks++;
  return quick;
}

async function assertDocumentLifecycles(
  admin: Headers,
  reader: Headers,
  noCompany: Headers,
  fixture: Fixture,
  bankAccount: Row,
): Promise<{
  invoice: Row;
  report: Row;
  reportItem: Row;
  bill: Row;
  billTransaction: Row;
  holding: Row;
}> {
  const autoInvoice = await request<Row>(
    "/finance/vat-invoices",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        direction: "INBOUND",
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        invoiceKind: "NORMAL",
        items: [],
      }),
    },
    201,
  );
  assert(
    typeof autoInvoice.docNo === "string" &&
      String(autoInvoice.docNo).trim() !== "",
    `发票自动编号错误: ${JSON.stringify(autoInvoice.docNo)}`,
  );
  await requestText(
    `/finance/vat-invoices/${autoInvoice.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  const autoReport = await request<Row>(
    "/finance/expense-reports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        docNo: "",
        expenseDate: today,
        employeeId: fixture.employeeID,
        paymentAccountId: fixture.accountSettle,
      }),
    },
    201,
  );
  assert(
    typeof autoReport.docNo === "string" &&
      String(autoReport.docNo).trim() !== "",
    `报销单自动编号错误: ${JSON.stringify(autoReport.docNo)}`,
  );
  await requestText(
    `/finance/expense-reports/${autoReport.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  stateChecks += 2;

  const invoice = await request<Row>(
    "/finance/vat-invoices",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        docNo: `${prefix}INV`,
        direction: "INBOUND",
        invoiceDate: today,
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        invoiceKind: "NORMAL",
        invoiceCode: `${prefix}IC`,
        invoiceNo: `${prefix}IN`,
        items: [{ name: `${prefix}项目`, quantity: "1", net_amount: "100" }],
        netTotal: "100",
        taxTotal: "0",
        grossTotal: "100",
        partyAccountId: fixture.accountPayable,
        amountAccountId: fixture.accountExpense,
        taxAccountId: null,
        remarks: null,
      }),
    },
    201,
  );
  ids.add(invoice.id);
  requireUpperEnum(invoice, "direction", ["INBOUND", "OUTBOUND"]);
  requireUpperEnum(invoice, "status", ["DRAFT", "AUDITED", "VOIDED", "REVERSED"]);
  requireDecimal(invoice, "netTotal", true);
  requireDecimal(invoice, "taxTotal", true);
  requireDecimal(invoice, "grossTotal", true);
  assert(
    invoice.postingDate === null &&
      invoice.auditedAt === null &&
      invoice.auditedById === null,
    "发票草稿 nullable/system wire 错误",
  );
  wireChecks += 3;
  const auditedInvoice = await request<Row>(
    `/finance/vat-invoices/${invoice.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  assert(
    auditedInvoice.status === "AUDITED" &&
      auditedInvoice.postingDate === today &&
      auditedInvoice.auditedAt !== null &&
      auditedInvoice.auditedById !== null,
    `发票审核状态机错误: ${JSON.stringify(auditedInvoice)}`,
  );
  stateChecks += 4;
  await assertGL("acc.vat_invoice", invoice.id, 2, "100");

  const report = await request<Row>(
    "/finance/expense-reports",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        docNo: `${prefix}EXP`,
        expenseDate: today,
        employeeId: fixture.employeeID,
        paymentAccountId: fixture.accountSettle,
        remarks: null,
      }),
    },
    201,
  );
  ids.add(report.id);
  const reportItem = await request<Row>(
    "/finance/expense-report-items",
    {
      method: "POST",
      headers: admin,
      body: body({
        reportId: report.id,
        idx: 1,
        kind: "INVOICED",
        invoiceId: invoice.id,
        summary: null,
        amount: null,
        expenseAccountId: null,
        remarks: `${prefix}挂票`,
      }),
    },
    201,
  );
  ids.add(reportItem.id);
  requireUpperEnum(reportItem, "kind", ["INVOICED", "MANUAL"]);
  assert(
    reportItem.companyId === fixture.companyA &&
      reportItem.amount === null &&
      reportItem.expenseAccountId === null,
    "报销挂票行父派生/null wire 错误",
  );
  wireChecks += 3;
  const auditedReport = await request<Row>(
    `/finance/expense-reports/${report.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  assert(
    auditedReport.status === "AUDITED" &&
      auditedReport.postingDate === today &&
      auditedReport.auditedAt !== null,
    `报销审核状态机错误: ${JSON.stringify(auditedReport)}`,
  );
  stateChecks += 3;
  await assertGL("acc.expense_report", report.id, 2, "100");
  const blockedInvoice = await attempt(
    `/finance/vat-invoices/${invoice.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(
    isRuleFailure(blockedInvoice.status),
    `报销占用未阻止发票作废: ${blockedInvoice.status} ${blockedInvoice.text}`,
  );
  stateChecks++;
  const voidedReport = await request<Row>(
    `/finance/expense-reports/${report.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(voidedReport.status === "VOIDED", "报销作废终态错误");
  await assertCancelledGL("acc.expense_report", report.id);
  const voidedInvoice = await request<Row>(
    `/finance/vat-invoices/${invoice.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(voidedInvoice.status === "VOIDED", "发票作废终态错误");
  await assertCancelledGL("acc.vat_invoice", invoice.id);
  stateChecks += 2;

  const reverseInvoice = await request<Row>(
    "/finance/vat-invoices",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        docNo: `${prefix}REV`,
        direction: "INBOUND",
        invoiceDate: today,
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        invoiceKind: "SPECIAL",
        invoiceCode: `${prefix}RC`,
        invoiceNo: `${prefix}RN`,
        items: [],
        netTotal: "90",
        taxTotal: "10",
        grossTotal: "100",
        partyAccountId: fixture.accountPayable,
        amountAccountId: fixture.accountExpense,
        taxAccountId: fixture.accountInterest,
      }),
    },
    201,
  );
  ids.add(reverseInvoice.id);
  await request<Row>(
    `/finance/vat-invoices/${reverseInvoice.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  const reversed = await request<Row>(
    `/finance/vat-invoices/${reverseInvoice.id}/reverse`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today, redInvoiceNo: `${prefix}RED` }),
    },
  );
  assert(
    reversed.status === "REVERSED" &&
      reversed.redInvoiceNo === `${prefix}RED`,
    `发票红冲终态错误: ${JSON.stringify(reversed)}`,
  );
  const reverseGL = (await db`
    SELECT
      count(*) FILTER (WHERE is_reversed)::int AS originals,
      count(*) FILTER (WHERE is_reversal)::int AS reversals
    FROM acc_gl_entry
    WHERE voucher_type='acc.vat_invoice'
      AND voucher_id=${reverseInvoice.id}::uuid
  `) as Array<{ originals: number; reversals: number }>;
  assert(
    Number(reverseGL[0]?.originals) > 0 &&
      Number(reverseGL[0]?.reversals) > 0,
    `红冲 GL C/D 错误: ${JSON.stringify(reverseGL)}`,
  );
  stateChecks += 3;

  const receive = await request<Row>(
    "/finance/bill-transactions",
    {
      method: "POST",
      headers: admin,
      body: body({
        transactionType: "RECEIVE",
        companyId: fixture.companyA,
        bankAccountId: bankAccount.id,
        occurredOn: today,
        subStart: 3_000_000_001,
        subEnd: 3_000_001_000,
        amount: "10",
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        postingDate: today,
        billAttrs: {
          bill_no: `${prefix}BILL`,
          bill_kind: "BANK_ACCEPTANCE",
          due_date: future,
          face_amount: "40000000",
          transferable: true,
          remarks: null,
        },
        billAccountId: fixture.accountBill,
        settleAccountId: fixture.accountSettle,
        interestAccountId: null,
        remarks: null,
      }),
    },
    201,
  );
  ids.add(receive.id);
  assert(
    Number(receive.subStart) === 3_000_000_001 &&
      Number(receive.subEnd) === 3_000_001_000,
    `bill bigint 被截为 32-bit: ${JSON.stringify(receive)}`,
  );
  requireDecimal(receive, "amount");
  requireUpperEnum(receive, "transactionType", [
    "RECEIVE",
    "ENDORSE",
    "SETTLE",
    "DISCOUNT",
    "REALLOCATE",
  ]);
  const [auditOne, auditTwo] = await Promise.all([
    attempt<Row>(`/finance/bill-transactions/${receive.id}/audit`, {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    }),
    attempt<Row>(`/finance/bill-transactions/${receive.id}/audit`, {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    }),
  ]);
  assert(
    [auditOne.status, auditTwo.status].filter((status) => status === 200)
      .length === 1,
    `承兑并发双审未串行: ${auditOne.status} ${auditOne.text} / ${auditTwo.status} ${auditTwo.text}`,
  );
  concurrencyChecks++;
  const billTransaction = await request<Row>(
    `/finance/bill-transactions/${receive.id}`,
    { headers: admin },
  );
  assert(
    billTransaction.status === "AUDITED" &&
      typeof billTransaction.docNo === "string" &&
      String(billTransaction.docNo).trim() !== "" &&
      billTransaction.auditedAt !== null &&
      billTransaction.auditedById !== null,
    `承兑审核状态错误: ${JSON.stringify(billTransaction)}`,
  );
  stateChecks += 4;
  await assertGL("acc.bill_transaction", receive.id, 2, "10");
  const bill = await request<Row>(
    `/finance/bills/${String(billTransaction.billId)}`,
    { headers: reader },
  );
  assert(
    bill.billNo === `${prefix}BILL` &&
      bill.billKind === "BANK_ACCEPTANCE" &&
      bill.faceAmount === "40000000",
    `Bill wire/upsert 错误: ${JSON.stringify(bill)}`,
  );
  scopeChecks++;
  await requestText(
    `/finance/bills/${String(billTransaction.billId)}`,
    { headers: noCompany },
    404,
  );
  const hiddenBills = await query<Row>(noCompany, "/finance/bills/query");
  assert(
    !hiddenBills.results.some((row) => row.id === billTransaction.billId),
    "BillCompanyScope 空公司 actor 未 fail-closed",
  );
  scopeChecks += 2;
  const holdings = await query<Row>(
    reader,
    "/finance/bill-holdings/query",
    { sourceTransactionId: { kind: "fk", op: "in", values: [receive.id] } },
  );
  assert(holdings.count === 1, `接收审核 holding=${holdings.count}, want 1`);
  const holding = holdings.results[0]!;
  ids.add(holding.id);
  assert(
    holding.subStart === 3_000_000_001 &&
      holding.subEnd === 3_000_001_000 &&
      holding.amount === "10",
    `holding bigint/decimal wire 错误: ${JSON.stringify(holding)}`,
  );
  wireChecks += 3;
  const holdingAudits = (await db`
    SELECT count(*)::int AS count
      FROM sys_audit_log
     WHERE resource='acc_bill_holding'
       AND record_id=${holding.id}::uuid
  `) as Array<{ count: number }>;
  assert(Number(holdingAudits[0]!.count) === 0, "Holding 不得有独立审计/写者");
  auditChecks++;

  const endorse = await request<Row>(
    "/finance/bill-transactions",
    {
      method: "POST",
      headers: admin,
      body: body({
        transactionType: "ENDORSE",
        companyId: fixture.companyA,
        bankAccountId: bankAccount.id,
        billId: bill.id,
        occurredOn: today,
        subStart: 3_000_000_001,
        subEnd: 3_000_000_500,
        amount: "5",
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        postingDate: today,
        billAccountId: fixture.accountBill,
        settleAccountId: fixture.accountSettle,
      }),
    },
    201,
  );
  ids.add(endorse.id);
  await request<Row>(
    `/finance/bill-transactions/${endorse.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  const consumed = await attempt(
    `/finance/bill-transactions/${receive.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(
    isRuleFailure(consumed.status),
    `后续已消耗时 RECEIVE void 应整体回滚: ${consumed.status} ${consumed.text}`,
  );
  const receiveAfter = await request<Row>(
    `/finance/bill-transactions/${receive.id}`,
    { headers: admin },
  );
  assert(receiveAfter.status === "AUDITED", "失败 void 改写了承兑状态");
  await assertGL("acc.bill_transaction", receive.id, 2, "10");
  stateChecks += 2;

  const voidable = await request<Row>(
    "/finance/bill-transactions",
    {
      method: "POST",
      headers: admin,
      body: body({
        transactionType: "RECEIVE",
        companyId: fixture.companyA,
        bankAccountId: bankAccount.id,
        occurredOn: today,
        subStart: 1,
        subEnd: 1000,
        amount: "10",
        partyType: "EMPLOYEE",
        partyId: fixture.employeeID,
        postingDate: today,
        billAttrs: {
          bill_no: `${prefix}VOIDBILL`,
          bill_kind: "COMMERCIAL_ACCEPTANCE",
          due_date: future,
          face_amount: "10",
          transferable: true,
        },
        billAccountId: fixture.accountBill,
        settleAccountId: fixture.accountSettle,
      }),
    },
    201,
  );
  ids.add(voidable.id);
  await request<Row>(
    `/finance/bill-transactions/${voidable.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  const voidedTransaction = await request<Row>(
    `/finance/bill-transactions/${voidable.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(
    voidedTransaction.status === "VOIDED",
    `承兑作废终态错误: ${JSON.stringify(voidedTransaction)}`,
  );
  await assertCancelledGL("acc.bill_transaction", voidable.id);
  const voidedHolding = (await db`
    SELECT count(*)::int AS count
      FROM acc_bill_holding
     WHERE source_transaction_id=${voidable.id}::uuid
  `) as Array<{ count: number }>;
  assert(
    Number(voidedHolding[0]!.count) === 0,
    "承兑作废后 BillLedger holding 未重放清除",
  );
  stateChecks += 2;
  const currentHoldings = await query<Row>(
    reader,
    "/finance/bill-holdings/query",
    { billId: { kind: "fk", op: "in", values: [bill.id] } },
  );
  assert(
    currentHoldings.count === 1 &&
      currentHoldings.results[0]?.amount === "5",
    `ENDORSE 后 holding 重放结果错误: ${JSON.stringify(currentHoldings)}`,
  );
  const currentHolding = currentHoldings.results[0]!;
  stateChecks++;

  return {
    invoice: voidedInvoice,
    report: voidedReport,
    reportItem,
    bill,
    billTransaction,
    holding: currentHolding,
  };
}

async function assertInvoiceReconciliationTodo(
  admin: Headers,
  fixture: Fixture,
): Promise<void> {
  const reconciliationID = randomUUID();
  const reconciliationItemID = randomUUID();
  const todoID = randomUUID();
  const fakeDeliveryItemID = randomUUID();
  // 已确认常规对账是此验收切片的前置事实。item 的来源 FK 与发票联动无关，
  // 仅在本事务暂时关闭复制触发器写入一条精确金额快照，避免把销售履约整条链
  // 混进 PR-2.20；发票仍只经公开 REST 动作驱动 close/reopen/todo/GL。
  await db.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role='replica'`;
    await tx`INSERT INTO sal_reconciliation(
      id,reconciliation_no,reconciliation_type,party_type,party_id,remarks,
      status,company_id,debit_account_id,credit_account_id
    ) VALUES(
      ${reconciliationID}::uuid,${prefix + "SALREC"},'regular','customer',
      ${fixture.customerID}::uuid,${prefix + "发票联动"},'confirmed',
      ${fixture.companyA}::uuid,${fixture.accountCounter}::uuid,
      ${fixture.accountPayable}::uuid
    )`;
    await tx`INSERT INTO sal_reconciliation_item(
      id,idx,qty,base_qty,amount,base_amount,remarks,reconciliation_id,
      company_id,delivery_item_id
    ) VALUES(
      ${reconciliationItemID}::uuid,1,1,1,100,100,${prefix + "金额快照"},
      ${reconciliationID}::uuid,${fixture.companyA}::uuid,
      ${fakeDeliveryItemID}::uuid
    )`;
    await tx`INSERT INTO sys_todo(
      id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
      source_changed_at,company_id
    ) VALUES(
      ${todoID}::uuid,'issue_invoice','sales.reconciliation',
      ${reconciliationID}::uuid,${prefix + "SALREC"},'customer',
      ${fixture.customerID}::uuid,100,'active',(now() AT TIME ZONE 'utc'),
      ${fixture.companyA}::uuid
    )`;
  });
  const invoice = await request<Row>(
    "/finance/vat-invoices",
    {
      method: "POST",
      headers: admin,
      body: body({
        companyId: fixture.companyA,
        docNo: `${prefix}LINK`,
        direction: "OUTBOUND",
        invoiceDate: today,
        partyType: "CUSTOMER",
        partyId: fixture.customerID,
        invoiceKind: "NORMAL",
        invoiceCode: `${prefix}LC`,
        invoiceNo: `${prefix}LN`,
        items: [],
        netTotal: "100",
        taxTotal: "0",
        grossTotal: "100",
        partyAccountId: fixture.accountPayable,
        amountAccountId: fixture.accountExpense,
        salReconciliationId: reconciliationID,
      }),
    },
    201,
  );
  ids.add(invoice.id);
  const audited = await request<Row>(
    `/finance/vat-invoices/${invoice.id}/audit`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today }),
    },
  );
  assert(audited.status === "AUDITED", "关联销售对账发票审核失败");
  const closed = (await db`
    SELECT
      r.status,
      t.status AS "todoStatus",
      t.closed_reason AS "closedReason",
      (SELECT count(*) FROM acc_gl_entry e
        WHERE e.voucher_type='acc.vat_invoice'
          AND e.voucher_id=${invoice.id}::uuid
          AND NOT e.is_cancelled)::int AS entries
    FROM sal_reconciliation r
    JOIN sys_todo t ON t.id=${todoID}::uuid
    WHERE r.id=${reconciliationID}::uuid
  `) as Array<{
    status: string;
    todoStatus: string;
    closedReason: string | null;
    entries: number;
  }>;
  assert(
    closed[0]?.status === "closed" &&
      closed[0]?.todoStatus === "closed" &&
      closed[0]?.closedReason === "invoice_audit" &&
      Number(closed[0]?.entries) === 4,
    `发票审核未原子联动对账/todo/双 GL: ${JSON.stringify(closed)}`,
  );
  stateChecks += 4;
  const voided = await request<Row>(
    `/finance/vat-invoices/${invoice.id}/void`,
    { method: "POST", headers: admin },
  );
  assert(voided.status === "VOIDED", "关联对账发票作废失败");
  const reopened = (await db`
    SELECT
      r.status,
      count(*) FILTER (WHERE t.status='closed')::int AS closed,
      count(*) FILTER (WHERE t.status='active')::int AS active,
      (SELECT count(*) FROM acc_gl_entry e
        WHERE e.voucher_type='acc.vat_invoice'
          AND e.voucher_id=${invoice.id}::uuid
          AND e.is_cancelled)::int AS cancelled
    FROM sal_reconciliation r
    LEFT JOIN sys_todo t
      ON t.source_type='sales.reconciliation' AND t.source_id=r.id
    WHERE r.id=${reconciliationID}::uuid
    GROUP BY r.status
  `) as Array<{
    status: string;
    closed: number;
    active: number;
    cancelled: number;
  }>;
  assert(
    reopened[0]?.status === "confirmed" &&
      Number(reopened[0]?.closed) === 1 &&
      Number(reopened[0]?.active) === 1 &&
      Number(reopened[0]?.cancelled) === 4,
    `发票作废未原子 reopen/todo/GL cancel: ${JSON.stringify(reopened)}`,
  );
  stateChecks += 4;
}

async function assertGL(
  voucherType: string,
  voucherID: string,
  entries: number,
  total: string,
): Promise<void> {
  const rows = (await db`
    SELECT
      count(*) FILTER (WHERE NOT is_cancelled)::int AS count,
      COALESCE(sum(debit) FILTER (WHERE NOT is_cancelled),0)::text AS debit,
      COALESCE(sum(credit) FILTER (WHERE NOT is_cancelled),0)::text AS credit
    FROM acc_gl_entry
    WHERE voucher_type=${voucherType} AND voucher_id=${voucherID}::uuid
  `) as Array<{ count: number; debit: string; credit: string }>;
  assert(
    Number(rows[0]?.count) === entries &&
      Number(rows[0]?.debit) === Number(total) &&
      Number(rows[0]?.credit) === Number(total),
    `${voucherType} GL A/B/C/D 错误: ${JSON.stringify(rows)}`,
  );
  stateChecks += 3;
}

async function assertCancelledGL(
  voucherType: string,
  voucherID: string,
): Promise<void> {
  const rows = (await db`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE is_cancelled)::int AS cancelled
    FROM acc_gl_entry
    WHERE voucher_type=${voucherType} AND voucher_id=${voucherID}::uuid
  `) as Array<{ total: number; cancelled: number }>;
  assert(
    Number(rows[0]?.total) > 0 &&
      Number(rows[0]?.total) === Number(rows[0]?.cancelled),
    `${voucherType} GL Cancel 未原子完成: ${JSON.stringify(rows)}`,
  );
  stateChecks++;
}

async function assertWireSurface(
  admin: Headers,
  known: Map<string, Row>,
): Promise<void> {
  const keyMap: Record<string, readonly string[]> = {
    "bank-accounts": [
      "id", "alias", "bankName", "branchName", "holderName", "accountNo",
      "active", "note", "insertedAt", "updatedAt", "companyId", "currencyId",
      "accountId",
    ],
    "bank-transactions": [
      "id", "occurredAt", "income", "expense", "balance", "counterpartyName",
      "counterpartyAccount", "summary", "note", "reconciledAmount",
      "unreconciledAmount", "reconcileStatus", "insertedAt", "updatedAt",
      "companyId", "bankAccountId",
    ],
    "bank-import-templates": [
      "id", "name", "startRow", "datetimeCol", "datetimeFormat", "dateCol",
      "dateFormat", "timeCol", "timeFormat", "incomeCol", "expenseCol",
      "amountCol", "balanceCol", "counterpartyNameCol",
      "counterpartyAccountCol", "summaryCol", "noteCol", "insertedAt",
      "updatedAt", "companyId", "bankAccountId",
    ],
    "bank-imports": [
      "id", "status", "error", "importedAt", "insertedAt", "updatedAt",
      "companyId", "bankAccountId", "templateId", "fileId", "createdById",
      "importedById", "itemCount", "errorCount",
    ],
    "bank-import-items": [
      "id", "rowNo", "occurredAt", "income", "expense", "balance",
      "counterpartyName", "counterpartyAccount", "summary", "note", "error",
      "insertedAt", "updatedAt", "importId", "companyId", "transactionId",
    ],
    "bank-reconciliations": [
      "id", "amount", "insertedAt", "updatedAt", "companyId",
      "bankTransactionId", "journalId",
    ],
    "vat-invoices": [
      "id", "docNo", "direction", "invoiceDate", "postingDate", "partyType",
      "partyId", "invoiceKind", "invoiceCode", "invoiceNo", "sellerName",
      "sellerTaxNo", "sellerAddressPhone", "sellerBankAccount", "buyerName",
      "buyerTaxNo", "buyerAddressPhone", "buyerBankAccount", "items",
      "netTotal", "taxTotal", "grossTotal", "issuer", "reviewer", "payee",
      "remarks", "redInvoiceNo", "status", "auditedAt", "insertedAt",
      "updatedAt", "companyId", "partyAccountId", "amountAccountId",
      "taxAccountId", "mirrorInvoiceId", "salReconciliationId",
      "purReconciliationId", "createdById", "auditedById",
    ],
    "expense-reports": [
      "id", "docNo", "expenseDate", "postingDate", "remarks", "status",
      "auditedAt", "insertedAt", "updatedAt", "companyId", "employeeId",
      "paymentAccountId", "createdById", "auditedById",
    ],
    "expense-report-items": [
      "id", "idx", "kind", "summary", "amount", "remarks", "insertedAt",
      "updatedAt", "reportId", "companyId", "invoiceId", "expenseAccountId",
    ],
    bills: [
      "id", "billNo", "billKind", "issueDate", "dueDate", "faceAmount",
      "drawerName", "drawerAccount", "drawerBankName", "drawerBankNo",
      "payeeName", "payeeAccount", "payeeBankName", "payeeBankNo",
      "acceptorName", "acceptorAccount", "acceptorBankName", "acceptorBankNo",
      "transferable", "acceptanceDate", "remarks", "insertedAt", "updatedAt",
    ],
    "bill-transactions": [
      "id", "docNo", "transactionType", "occurredOn", "subStart", "subEnd",
      "amount", "partyType", "partyId", "discountOrg", "discountRate",
      "interest", "netAmount", "postingDate", "status", "auditedAt", "remarks",
      "insertedAt", "updatedAt", "companyId", "bankAccountId",
      "toBankAccountId", "billId", "billAccountId", "settleAccountId",
      "interestAccountId", "createdById", "auditedById",
    ],
    "bill-holdings": [
      "id", "billNo", "subStart", "subEnd", "amount", "dueDate", "acquiredOn",
      "insertedAt", "companyId", "bankAccountId", "billId",
      "sourceTransactionId",
    ],
  };
  for (const path of resourcePaths) {
    const expected = known.get(path);
    assert(expected, `缺少 ${path} wire 验收事实`);
    const got = await request<Row>(`/finance/${path}/${expected.id}`, {
      headers: admin,
    });
    requireKeys(got, keyMap[path]!, `${path} GET`);
    const list = await query<Row>(admin, `/finance/${path}/query`);
    const listed = list.results.find((row) => row.id === expected.id);
    assert(listed, `${path} list 未返回已知记录 ${expected.id}`);
    requireKeys(listed, keyMap[path]!, `${path} list`);
  }
}

async function assertAllCompanyScopes(
  reader: Headers,
  importer: Headers,
  noCompany: Headers,
  known: Map<string, Row>,
): Promise<void> {
  for (const path of resourcePaths) {
    if (path === "bills") continue;
    const row = known.get(path);
    assert(row, `缺少 ${path} CompanyScope 验收事实`);
    const positive =
      path === "bank-imports" || path === "bank-import-items"
        ? importer
        : reader;
    await request<Row>(`/finance/${path}/${row.id}`, { headers: positive });
    await requestText(
      `/finance/${path}/${row.id}`,
      { headers: noCompany },
      404,
    );
    const empty = await query<Row>(noCompany, `/finance/${path}/query`);
    assert(
      !empty.results.some((candidate) => candidate.id === row.id),
      `${path} CompanyScope 空公司 actor 未 fail-closed`,
    );
    scopeChecks += 3;
  }
}

async function assertOCR(
  admin: Headers,
): Promise<void> {
  const png = await upload(
    admin,
    `${prefix}-ocr.png`,
    "image/png",
    Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]),
  );
  const before = (await db`
    SELECT
      (SELECT count(*) FROM acc_vat_invoice WHERE doc_no LIKE ${prefix + "%"})::int AS invoices,
      (SELECT count(*) FROM acc_bill_transaction WHERE doc_no LIKE ${prefix + "%"})::int AS bills
  `) as Array<{ invoices: number; bills: number }>;
  for (const path of [
    "/finance/vat-invoices/ocr",
    "/finance/bill-transactions/ocr",
  ]) {
    const result = await attempt(path, {
      method: "POST",
      headers: admin,
      body: body({ fileId: png.id }),
    });
    assert(
      result.status === 200 || isRuleFailure(result.status),
      `${path} OCR 应返回预填或可读失败: ${result.status} ${result.text}`,
    );
    if (result.status === 200) {
      assert(
        result.data && typeof result.data === "object",
        `${path} OCR 预填必须是结构化对象`,
      );
    } else {
      assert(
        /OCR|阿里云|凭证|配置|fileId/.test(result.text),
        `${path} OCR 失败不可读: ${result.text}`,
      );
    }
    stateChecks++;
  }
  const after = (await db`
    SELECT
      (SELECT count(*) FROM acc_vat_invoice WHERE doc_no LIKE ${prefix + "%"})::int AS invoices,
      (SELECT count(*) FROM acc_bill_transaction WHERE doc_no LIKE ${prefix + "%"})::int AS bills
  `) as Array<{ invoices: number; bills: number }>;
  same(after, before, "OCR 只能返回预填，不得落业务记录");
  stateChecks++;
}

async function assertAudits(): Promise<void> {
  const rows = (await db`
    SELECT resource,action_type AS "actionType",count(*)::int AS count
      FROM sys_audit_log
     WHERE record_label LIKE ${prefix + "%"}
        OR company_id IN (
          SELECT id FROM bas_company WHERE code LIKE ${prefix + "%"}
        )
     GROUP BY resource,action_type
  `) as Array<{ resource: string; actionType: string; count: number }>;
  for (const resource of [
    "acc_bank_account",
    "acc_bank_transaction",
    "acc_bank_import_template",
    "acc_bank_import",
    "acc_vat_invoice",
    "acc_expense_report",
    "acc_bill_transaction",
    "acc_bank_reconciliation",
  ]) {
    assert(
      rows.some((row) => row.resource === resource && Number(row.count) > 0),
      `${resource} 缺 Audit Fragment`,
    );
    auditChecks++;
  }
}

async function cleanup(admin?: Headers, fixture?: Fixture): Promise<void> {
  void admin;
  await db.begin(async (tx) => {
    if (fixture) {
      await tx`DELETE FROM sys_audit_log
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)
           OR record_label LIKE ${prefix + "%"}`;
      await tx`DELETE FROM acc_gl_entry
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_reconciliation
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_gl_journal_line
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_gl_journal
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bill_holding
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bill_transaction
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bill WHERE bill_no LIKE ${prefix + "%"}`;
      await tx`DELETE FROM acc_expense_report_item
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_expense_report
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_vat_invoice
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sys_todo_state WHERE todo_id IN (
        SELECT id FROM sys_todo
         WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)
      )`;
      await tx`DELETE FROM sys_todo
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sal_reconciliation_item
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sal_reconciliation
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_import_item
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_import
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_import_template
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_transaction
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_bank_account
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM bas_account WHERE company_id=${fixture.companyA}::uuid`;
      await tx`DELETE FROM hr_employees WHERE id=${fixture.employeeID}::uuid`;
      await tx`DELETE FROM sal_customers WHERE id=${fixture.customerID}::uuid`;
    }
    await tx`DELETE FROM sys_user_role WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_user_company WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_user
      WHERE username LIKE ${prefix.toLowerCase() + "%"}`;
    await tx`DELETE FROM sys_role_permission WHERE role_id IN (
      SELECT id FROM sys_role WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM sys_role WHERE code LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sys_numbering_counter WHERE rule_id IN (
      SELECT id FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sys_file WHERE filename LIKE ${prefix + "%"}`;
    if (storageID) {
      await tx`UPDATE sys_storage SET is_default=false WHERE id=${storageID}::uuid`;
      await tx`DELETE FROM sys_storage WHERE id=${storageID}::uuid`;
      if (previousStorageID) {
        await tx`UPDATE sys_storage SET is_default=true
          WHERE id=${previousStorageID}::uuid`;
      }
    }
    if (fixture) {
      await tx`DELETE FROM bas_company
        WHERE id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM bas_currency WHERE id=${fixture.currencyID}::uuid`;
    }
  });
  rmSync(`/tmp/${prefix.toLowerCase()}-files`, {
    recursive: true,
    force: true,
  });
  storageID = null;
  const rows = (await db`
    SELECT
      (SELECT count(*) FROM bas_company WHERE code LIKE ${prefix + "%"})::int AS companies,
      (SELECT count(*) FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"})::int AS users,
      (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"})::int AS roles,
      (SELECT count(*) FROM sys_file WHERE filename LIKE ${prefix + "%"})::int AS files,
      (SELECT count(*) FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})::int AS rules,
      (SELECT count(*) FROM sys_audit_log WHERE record_label LIKE ${prefix + "%"})::int AS audits
  `) as Array<Record<string, number>>;
  cleanupCount = Object.values(rows[0]!).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  assert(
    cleanupCount === 0,
    `Finance 验收 cleanup=${cleanupCount}: ${JSON.stringify(rows[0])}`,
  );
}

const fixture = fixtureIDs();
const admin = await login(username, password);

try {
  await cleanup(admin);
  await createFixture(fixture);
  await setupStorage();
  await ensureNumberingRule(admin, "acc.gl_journal", "GL");
  await ensureNumberingRule(admin, "acc.bill_transaction", "BILLTX");
  await ensureNumberingRule(admin, "acc.vat_invoice", "INV");
  await ensureNumberingRule(admin, "acc.expense_report", "EXP");

  const readerActor = await createRoleUser(
    admin,
    "READ",
    readPermissions,
    [fixture.companyA],
  );
  readerRoleID = readerActor.roleID;
  readerUserID = readerActor.userID;
  const noCompanyActor = await createRoleUser(
    admin,
    "NOCOMPANY",
    [...readPermissions, "acc.bank_transaction:import"],
    [],
  );
  noCompanyRoleID = noCompanyActor.roleID;
  noCompanyUserID = noCompanyActor.userID;
  const importActor = await createRoleUser(
    admin,
    "IMPORT",
    [
      "acc.bank_transaction:read",
      "acc.bank_transaction:import",
      "acc.bank_import_template:read",
      "sys.file:read",
    ],
    [fixture.companyA],
  );
  importRoleID = importActor.roleID;
  importUserID = importActor.userID;

  await assertMeta(admin, readerActor.headers);
  await assertPermissionSurface(readerActor.headers);
  await assertInternalSurface(admin);

  const banking = await createBankingFacts(admin, fixture);
  await assertScopes(readerActor.headers, fixture, banking);
  const imported = await assertImportLifecycle(
    admin,
    importActor.headers,
    fixture,
    banking.accountA,
    banking.template,
  );
  const reconciliation = await assertReconciliation(
    admin,
    fixture,
    banking.accountA,
    banking.transactionA,
  );
  const documents = await assertDocumentLifecycles(
    admin,
    readerActor.headers,
    noCompanyActor.headers,
    fixture,
    banking.accountA,
  );
  await assertInvoiceReconciliationTodo(admin, fixture);

  const known = new Map<string, Row>([
    ["bank-accounts", banking.accountA],
    ["bank-transactions", banking.transactionA],
    ["bank-import-templates", banking.template],
    ["bank-imports", imported.batch],
    ["bank-import-items", imported.item],
    ["bank-reconciliations", reconciliation],
    ["vat-invoices", documents.invoice],
    ["expense-reports", documents.report],
    ["expense-report-items", documents.reportItem],
    ["bills", documents.bill],
    ["bill-transactions", documents.billTransaction],
    ["bill-holdings", documents.holding],
  ]);
  await assertWireSurface(admin, known);
  await assertAllCompanyScopes(
    readerActor.headers,
    importActor.headers,
    noCompanyActor.headers,
    known,
  );
  await assertOCR(admin);
  await assertAudits();
  assert(graphqlCalls === 0, `REST verifier 意外请求 GraphQL ${graphqlCalls} 次`);
  await cleanup(admin, fixture);
  assert(cleanupCount === 0, `cleanup=${cleanupCount}`);
  console.log(
    [
      "finance operations REST acceptance ok",
      `meta=${metaChecks}`,
      `permissionFirst=${permissionChecks}`,
      `internal=${unavailableChecks}`,
      `wire=${wireChecks}`,
      `scope=${scopeChecks}`,
      `states=${stateChecks}`,
      `audits=${auditChecks}`,
      `concurrency=${concurrencyChecks}`,
      `graphql=${graphqlCalls}`,
      `cleanup=${cleanupCount}`,
    ].join(" "),
  );
} finally {
  await cleanup(admin, fixture);
  await db.close();
}
