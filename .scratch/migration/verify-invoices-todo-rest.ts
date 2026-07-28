/**
 * 工单 09 发票 + 待办 REST 验收（不依赖银行/报销/票据）。
 * 覆盖：费用票生命周期、销项↔对账结单/重开/todo、OCR 入口、待办 query/read/dismiss/unread。
 */
import { SQL } from "bun";
import { randomUUID } from "node:crypto";

const baseURL =
  process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const db = new SQL(databaseURL);
const suffix = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR09${suffix}`;
const missingID = randomUUID();
const today = "2098-07-26";

type Headers = Record<string, string>;
type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type Todo = Row & {
  type: string;
  status: string;
  dismissed: boolean;
  myReadAt: string | null;
  draftInvoiceLinked: boolean;
};

type Fixture = {
  currencyID: string;
  companyA: string;
  companyB: string;
  employeeID: string;
  customerID: string;
  accountPayable: string;
  accountExpense: string;
  accountTax: string;
  accountSalesDebit: string;
  accountSalesCredit: string;
};

const ids = new Set<string>();
let stateChecks = 0;
let wireChecks = 0;
let metaChecks = 0;
let permissionChecks = 0;
let todoChecks = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

async function attempt<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string; data?: T }> {
  const response = await fetch(baseURL + path, init);
  const text = await response.text();
  let data: T | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // keep text
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

function requireUpperEnum(row: Row, key: string, allowed: string[]): void {
  const value = String(row[key] ?? "");
  assert(allowed.includes(value), `${key} wire 枚举应为大写之一: ${value}`);
  wireChecks++;
}

function requireDecimal(row: Row, key: string, nullable = false): void {
  const value = row[key];
  if (nullable && value === null) {
    wireChecks++;
    return;
  }
  assert(
    typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value),
    `${key} 必须为十进制字符串: ${JSON.stringify(value)}`,
  );
  wireChecks++;
}

function isRuleFailure(status: number): boolean {
  return status === 400 || status === 409 || status === 422;
}

async function ensureNumberingRule(
  admin: Headers,
  resource: string,
  literal: string,
): Promise<void> {
  const listed = await request<List<Row>>("/system/numbering/rules/query", {
    method: "POST",
    headers: admin,
    body: body({
      limit: 200,
      filter: { resource: { kind: "text", op: "eq", value: resource } },
    }),
  });
  if (listed.results.some((r) => r.enabled === true)) return;
  const created = await request<Row>(
    "/system/numbering/rules",
    {
      method: "POST",
      headers: admin,
      body: body({
        resource,
        name: `${prefix}-${resource}`,
        enabled: true,
        segments: [
          { type: "text", value: `${literal}-` },
          { type: "seq", padding: 4 },
        ],
      }),
    },
    201,
  );
  ids.add(created.id);
}

async function createFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    currencyID: randomUUID(),
    companyA: randomUUID(),
    companyB: randomUUID(),
    employeeID: randomUUID(),
    customerID: randomUUID(),
    accountPayable: randomUUID(),
    accountExpense: randomUUID(),
    accountTax: randomUUID(),
    accountSalesDebit: randomUUID(),
    accountSalesCredit: randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES(${fixture.currencyID}::uuid,${prefix + "币"},${"V" + suffix.slice(0, 2)},'¤',true)
    `;
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id) VALUES
        (${fixture.companyA}::uuid,${"A" + suffix},${prefix + "公司A"},'A',${fixture.currencyID}::uuid),
        (${fixture.companyB}::uuid,${"B" + suffix},${prefix + "公司B"},'B',${fixture.currencyID}::uuid)
    `;
    await tx`
      INSERT INTO hr_employees(id,code,name)
      VALUES(${fixture.employeeID}::uuid,${"E" + suffix},${prefix + "员工"})
    `;
    await tx`
      INSERT INTO sal_customers(id,code,name,short_name)
      VALUES(${fixture.customerID}::uuid,${"C" + suffix},${prefix + "客户"},'C')
    `;
    await tx`
      INSERT INTO bas_account(id,code,name,direction,is_group,active,company_id,currency_id,role) VALUES
        (${fixture.accountPayable}::uuid,${"P" + suffix},${prefix + "应付"},'credit',false,true,
          ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,'other_payable'),
        (${fixture.accountExpense}::uuid,${"X" + suffix},${prefix + "费用"},'debit',false,true,
          ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,NULL),
        (${fixture.accountTax}::uuid,${"T" + suffix},${prefix + "税额"},'debit',false,true,
          ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,NULL),
        (${fixture.accountSalesDebit}::uuid,${"SD" + suffix},${prefix + "销借"},'debit',false,true,
          ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,NULL),
        (${fixture.accountSalesCredit}::uuid,${"SC" + suffix},${prefix + "应收"},'credit',false,true,
          ${fixture.companyA}::uuid,${fixture.currencyID}::uuid,'receivable')
    `;
  });
  return fixture;
}

async function cleanup(fixture?: Fixture): Promise<void> {
  await db.begin(async (tx) => {
    await tx`DELETE FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sys_file WHERE filename LIKE ${prefix + "%"}`;
    // 本验收创建的角色/用户
    await tx`DELETE FROM sys_user_role WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_user_company WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_role_permission WHERE role_id IN (
      SELECT id FROM sys_role WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}`;
    await tx`DELETE FROM sys_role WHERE code LIKE ${prefix + "%"}`;
    if (fixture) {
      await tx`DELETE FROM sys_audit_log
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)
           OR record_label LIKE ${prefix + "%"}`;
      await tx`DELETE FROM acc_gl_entry
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sys_todo_state WHERE todo_id IN (
        SELECT id FROM sys_todo WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)
      )`;
      await tx`DELETE FROM sys_todo
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM acc_vat_invoice
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sal_reconciliation_item
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sal_reconciliation
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM bas_account
        WHERE company_id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM sal_customers WHERE id=${fixture.customerID}::uuid`;
      await tx`DELETE FROM hr_employees WHERE id=${fixture.employeeID}::uuid`;
      await tx`DELETE FROM bas_company
        WHERE id IN (${fixture.companyA}::uuid,${fixture.companyB}::uuid)`;
      await tx`DELETE FROM bas_currency WHERE id=${fixture.currencyID}::uuid`;
    }
  });
}

async function assertMeta(admin: Headers, reader: Headers): Promise<void> {
  const meta = await request<{ name: string; grid: { columns: unknown[] } }>(
    "/meta/resources/accVatInvoices",
    { headers: admin },
  );
  assert(meta.name === "accVatInvoices", "accVatInvoices Meta name");
  assert(Array.isArray(meta.grid.columns) && meta.grid.columns.length > 10, "grid columns");
  metaChecks += 2;
  const denied = await attempt("/meta/resources/accVatInvoices", { headers: reader });
  // reader may or may not have meta read via vat_invoice:read
  assert(
    denied.status === 200 || denied.status === 403,
    `reader meta status ${denied.status}`,
  );
  metaChecks++;
}

async function assertPermissionFirst(reader: Headers): Promise<void> {
  for (const [method, path] of [
    ["POST", "/finance/vat-invoices"],
    ["PATCH", `/finance/vat-invoices/${missingID}`],
    ["DELETE", `/finance/vat-invoices/${missingID}`],
    ["POST", `/finance/vat-invoices/${missingID}/audit`],
    ["POST", `/finance/vat-invoices/${missingID}/void`],
    ["POST", `/finance/vat-invoices/${missingID}/reverse`],
    ["POST", "/finance/vat-invoices/ocr"],
    ["POST", "/todos/query"],
    ["POST", `/todos/${missingID}/read`],
    ["POST", `/todos/${missingID}/dismiss`],
  ] as const) {
    const result = await attempt(path, {
      method,
      headers: reader,
      body: method === "GET" ? undefined : "{",
    });
    assert(
      result.status === 403,
      `permission-first ${method} ${path}: ${result.status} ${result.text}`,
    );
    permissionChecks++;
  }
}

async function assertExpenseInvoiceLifecycle(
  admin: Headers,
  fixture: Fixture,
): Promise<Row> {
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
    typeof autoInvoice.docNo === "string" && String(autoInvoice.docNo).trim() !== "",
    `发票自动编号错误: ${JSON.stringify(autoInvoice.docNo)}`,
  );
  await requestText(
    `/finance/vat-invoices/${autoInvoice.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  stateChecks++;

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
    "发票草稿 nullable wire 错误",
  );
  wireChecks++;

  const audited = await request<Row>(`/finance/vat-invoices/${invoice.id}/audit`, {
    method: "POST",
    headers: admin,
    body: body({ postingDate: today }),
  });
  assert(
    audited.status === "AUDITED" &&
      audited.postingDate === today &&
      audited.auditedAt !== null &&
      audited.auditedById !== null,
    `发票审核状态机错误: ${JSON.stringify(audited)}`,
  );
  stateChecks += 4;

  const gl = (await db`
    SELECT count(*)::int AS c, COALESCE(sum(debit),0)::text AS debit
    FROM acc_gl_entry
    WHERE voucher_type='acc.vat_invoice' AND voucher_id=${invoice.id}::uuid
      AND NOT is_cancelled AND NOT is_reversal
  `) as Array<{ c: number; debit: string }>;
  assert(Number(gl[0]?.c) === 2 && Number(gl[0]?.debit) === 100, `费用票 GL: ${JSON.stringify(gl)}`);
  stateChecks += 2;

  const voided = await request<Row>(`/finance/vat-invoices/${invoice.id}/void`, {
    method: "POST",
    headers: admin,
  });
  assert(voided.status === "VOIDED", "发票作废终态错误");
  stateChecks++;

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
        taxAccountId: fixture.accountTax,
      }),
    },
    201,
  );
  ids.add(reverseInvoice.id);
  await request<Row>(`/finance/vat-invoices/${reverseInvoice.id}/audit`, {
    method: "POST",
    headers: admin,
    body: body({ postingDate: today }),
  });
  const reversed = await request<Row>(
    `/finance/vat-invoices/${reverseInvoice.id}/reverse`,
    {
      method: "POST",
      headers: admin,
      body: body({ postingDate: today, redInvoiceNo: `${prefix}RED` }),
    },
  );
  assert(
    reversed.status === "REVERSED" && reversed.redInvoiceNo === `${prefix}RED`,
    `发票红冲终态错误: ${JSON.stringify(reversed)}`,
  );
  const reverseGL = (await db`
    SELECT
      count(*) FILTER (WHERE is_reversed)::int AS originals,
      count(*) FILTER (WHERE is_reversal)::int AS reversals
    FROM acc_gl_entry
    WHERE voucher_type='acc.vat_invoice' AND voucher_id=${reverseInvoice.id}::uuid
  `) as Array<{ originals: number; reversals: number }>;
  assert(
    Number(reverseGL[0]?.originals) > 0 && Number(reverseGL[0]?.reversals) > 0,
    `红冲 GL: ${JSON.stringify(reverseGL)}`,
  );
  stateChecks += 3;

  const keys = [
    "id", "docNo", "direction", "invoiceDate", "postingDate", "partyType",
    "partyId", "invoiceKind", "invoiceCode", "invoiceNo", "sellerName",
    "sellerTaxNo", "sellerAddressPhone", "sellerBankAccount", "buyerName",
    "buyerTaxNo", "buyerAddressPhone", "buyerBankAccount", "items",
    "netTotal", "taxTotal", "grossTotal", "issuer", "reviewer", "payee",
    "remarks", "redInvoiceNo", "status", "auditedAt", "insertedAt",
    "updatedAt", "companyId", "partyAccountId", "amountAccountId",
    "taxAccountId", "mirrorInvoiceId", "salReconciliationId",
    "purReconciliationId", "createdById", "auditedById",
  ];
  const got = await request<Row>(`/finance/vat-invoices/${voided.id}`, {
    headers: admin,
  });
  for (const key of keys) {
    assert(key in got, `vat-invoices wire 缺 ${key}`);
  }
  wireChecks += keys.length;
  return voided;
}

async function assertInvoiceReconTodo(
  admin: Headers,
  fixture: Fixture,
): Promise<void> {
  const reconciliationID = randomUUID();
  const reconciliationItemID = randomUUID();
  const todoID = randomUUID();
  const fakeDeliveryItemID = randomUUID();
  await db.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role='replica'`;
    await tx`INSERT INTO sal_reconciliation(
      id,reconciliation_no,reconciliation_type,party_type,party_id,remarks,
      status,company_id,debit_account_id,credit_account_id
    ) VALUES(
      ${reconciliationID}::uuid,${prefix + "SALREC"},'regular','customer',
      ${fixture.customerID}::uuid,${prefix + "发票联动"},'confirmed',
      ${fixture.companyA}::uuid,${fixture.accountSalesDebit}::uuid,
      ${fixture.accountSalesCredit}::uuid
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
        partyAccountId: fixture.accountSalesCredit,
        amountAccountId: fixture.accountSalesDebit,
        salReconciliationId: reconciliationID,
      }),
    },
    201,
  );
  ids.add(invoice.id);

  // 草稿关联徽标
  const todosWithDraft = await request<List<Todo>>("/todos/query", {
    method: "POST",
    headers: admin,
    body: body({ tab: "active", search: prefix + "SALREC", limit: 50 }),
  });
  const draftRow = todosWithDraft.results.find((t) => t.id === todoID);
  assert(draftRow?.draftInvoiceLinked === true, "草稿关联中徽标应可见");
  todoChecks++;

  const audited = await request<Row>(`/finance/vat-invoices/${invoice.id}/audit`, {
    method: "POST",
    headers: admin,
    body: body({ postingDate: today }),
  });
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

  const voided = await request<Row>(`/finance/vat-invoices/${invoice.id}/void`, {
    method: "POST",
    headers: admin,
  });
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

async function assertTodoUserState(
  admin: Headers,
  fixture: Fixture,
): Promise<void> {
  // 造两条 active 待办
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const todoA = randomUUID();
  const todoB = randomUUID();
  await db`
    INSERT INTO sys_todo(
      id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
      source_changed_at,company_id
    ) VALUES
      (${todoA}::uuid,'issue_invoice','sales.reconciliation',${sourceA}::uuid,
        ${prefix + "TA"},'customer',${fixture.customerID}::uuid,10,'active',
        (now() AT TIME ZONE 'utc'),${fixture.companyA}::uuid),
      (${todoB}::uuid,'receive_invoice','purchase.reconciliation',${sourceB}::uuid,
        ${prefix + "TB"},'customer',${fixture.customerID}::uuid,20,'active',
        (now() AT TIME ZONE 'utc'),${fixture.companyA}::uuid)
  `;

  const before = await request<{ count: number }>("/todos/unread-count", {
    headers: admin,
  });
  assert(before.count >= 2, `未读数至少 2: ${before.count}`);
  todoChecks++;

  const active = await request<List<Todo>>("/todos/query", {
    method: "POST",
    headers: admin,
    body: body({ tab: "active", search: prefix, limit: 50 }),
  });
  assert(active.count >= 2, `active 待办至少 2: ${active.count}`);
  todoChecks++;

  const marked = await request<Todo>(`/todos/${todoA}/read`, {
    method: "POST",
    headers: admin,
  });
  assert(marked.myReadAt !== null, "已读应写 myReadAt");
  todoChecks++;

  const afterRead = await request<{ count: number }>("/todos/unread-count", {
    headers: admin,
  });
  assert(afterRead.count === before.count - 1, "已读应减少未读数");
  todoChecks++;

  const dismissed = await request<Todo>(`/todos/${todoB}/dismiss`, {
    method: "POST",
    headers: admin,
  });
  assert(dismissed.dismissed === true, "忽略应标记 dismissed");
  todoChecks++;

  const hidden = await request<List<Todo>>("/todos/query", {
    method: "POST",
    headers: admin,
    body: body({ tab: "active", search: prefix + "TB", includeDismissed: false }),
  });
  assert(
    !hidden.results.some((t) => t.id === todoB),
    "忽略后默认列表应隐藏",
  );
  todoChecks++;

  const included = await request<List<Todo>>("/todos/query", {
    method: "POST",
    headers: admin,
    body: body({ tab: "active", search: prefix + "TB", includeDismissed: true }),
  });
  assert(
    included.results.some((t) => t.id === todoB && t.dismissed),
    "includeDismissed 应可见忽略行",
  );
  todoChecks++;

  // 无独立 Meta
  for (const resource of ["sysTodos", "sysTodoStates"]) {
    const r = await attempt(`/meta/resources/${resource}`, { headers: admin });
    assert(r.status === 404, `${resource} 不应公开 Meta`);
    todoChecks++;
  }
}

async function assertOCR(admin: Headers): Promise<void> {
  // 上传最小 PNG
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), `${prefix}-ocr.png`);
  const upload = await fetch(baseURL + "/files", {
    method: "POST",
    headers: { Authorization: admin.Authorization! },
    body: form,
  });
  const uploadText = await upload.text();
  assert(upload.status === 201, `upload: ${upload.status} ${uploadText}`);
  const file = JSON.parse(uploadText) as Row;
  ids.add(file.id);

  const before = (await db`
    SELECT count(*)::int AS c FROM acc_vat_invoice WHERE doc_no LIKE ${prefix + "%"}
  `) as Array<{ c: number }>;
  const result = await attempt("/finance/vat-invoices/ocr", {
    method: "POST",
    headers: admin,
    body: body({ fileId: file.id }),
  });
  assert(
    result.status === 200 || isRuleFailure(result.status),
    `OCR 应返回预填或可读失败: ${result.status} ${result.text}`,
  );
  if (result.status === 200) {
    assert(result.data && typeof result.data === "object", "OCR 预填必须是对象");
  } else {
    assert(
      /OCR|阿里云|凭证|配置|fileId/.test(result.text),
      `OCR 失败不可读: ${result.text}`,
    );
  }
  const after = (await db`
    SELECT count(*)::int AS c FROM acc_vat_invoice WHERE doc_no LIKE ${prefix + "%"}
  `) as Array<{ c: number }>;
  assert(Number(after[0]?.c) === Number(before[0]?.c), "OCR 不得落业务记录");
  stateChecks += 2;
}

async function createReader(admin: Headers, fixture: Fixture): Promise<Headers> {
  const role = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({
        code: `${prefix}_ro`,
        name: `${prefix}只读`,
        enabled: true,
      }),
    },
    201,
  );
  ids.add(role.id);
  await request(`/system/roles/${role.id}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({ permissions: ["acc.vat_invoice:read", "base.company:read"] }),
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
        username: `${prefix.toLowerCase()}_ro`,
        name: `${prefix}读者`,
        roleIds: [role.id],
        companyIds: [fixture.companyA],
      }),
    },
    201,
  );
  ids.add(created.user.id);
  return login(created.user.username, created.password);
}

const admin = await login(username, password);
let fixture: Fixture | null = null;
try {
  await cleanup();
  fixture = await createFixture();
  await ensureNumberingRule(admin, "acc.vat_invoice", "INV");
  const reader = await createReader(admin, fixture);

  await assertMeta(admin, reader);
  await assertPermissionFirst(reader);
  await assertExpenseInvoiceLifecycle(admin, fixture);
  await assertInvoiceReconTodo(admin, fixture);
  await assertTodoUserState(admin, fixture);
  await assertOCR(admin);

  await cleanup(fixture);
  console.log(
    [
      "invoices+todo REST acceptance ok",
      `meta=${metaChecks}`,
      `permissionFirst=${permissionChecks}`,
      `wire=${wireChecks}`,
      `states=${stateChecks}`,
      `todos=${todoChecks}`,
    ].join(" "),
  );
} catch (err) {
  if (fixture) await cleanup(fixture).catch(() => undefined);
  throw err;
} finally {
  await db.close();
}
