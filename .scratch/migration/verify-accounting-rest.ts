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
type List<T> = { count: number; results: T[] };
type RecordID = { id: string };
type Meta = {
  name: string;
  grid: Record<string, unknown> & { capabilities: string[] };
};
type Journal = RecordID & {
  voucherNo: string;
  date: string;
  postingDate: string | null;
  remarks: string | null;
  status: "DRAFT" | "AUDITED" | "CANCELLED";
  submittedAt: string | null;
  companyId: string;
  createdById: string | null;
  submittedById: string | null;
  debitTotal: string;
  creditTotal: string;
  company: { id: string; name: string };
};
type JournalLine = RecordID & {
  idx: number;
  debit: string;
  credit: string;
  partyType: string | null;
  partyId: string | null;
  remarks: string | null;
  journalId: string;
  companyId: string;
  accountId: string;
  currencyId: string | null;
  journal: { id: string; voucherNo: string };
  company: { id: string; name: string };
  account: { id: string; code: string; name: string };
};
type Entry = RecordID & {
  seq: number;
  postingDate: string;
  debit: string;
  credit: string;
  partyType: string | null;
  partyId: string | null;
  voucherType: string;
  voucherId: string;
  voucherNo: string;
  isCancelled: boolean;
  isReversed: boolean;
  isReversal: boolean;
  companyId: string;
  accountId: string;
  currencyId: string | null;
};
type ARAPReport = {
  asOf: string;
  roleAccounts: Record<
    string,
    Array<{ id: string; code: string; name: string }>
  >;
  rows: Array<{
    partyType: string | null;
    partyId: string | null;
    partyLabel: string;
    balances: Record<string, string>;
    netReceivable: string;
    netPayable: string;
  }>;
};
type Fixture = {
  companyId: string;
  companyName: string;
  otherCompanyId: string;
  receivableAccountId: string;
  receivableCurrencyId: string | null;
  offsetAccountId: string;
  offsetCurrencyId: string | null;
};

const resources = [
  "accGlEntries",
  "accGlJournals",
  "accGlJournalLines",
] as const;
const readPermissions = ["acc.gl_entry:read", "acc.gl_journal:read"];
const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 10)
  .toUpperCase();
const prefix = `ZZR212${suffix}`;
const trackedIDs = new Set<string>();
const journalIDs = new Set<string>();
const lineIDs = new Set<string>();
let customerID: string | null = null;
let roleID: string | null = null;
let userID: string | null = null;
let numberingRuleID: string | null = null;
let bankAccountID: string | null = null;
let bankTransactionID: string | null = null;
let bankReconciliationID: string | null = null;
let fixtureCurrencyID: string | null = null;
const fixtureCompanyIDs = new Set<string>();
const fixtureAccountIDs = new Set<string>();

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

function assertDecimal(
  value: unknown,
  expected: number,
  label: string,
): asserts value is string {
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

async function snapshot(
  resource: (typeof resources)[number],
  actor: "superadmin" | "read-only",
) {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.12",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

function journalQuery(search = prefix) {
  return body({ limit: 100, offset: 0, search });
}

function lineQuery(journalID: string) {
  return body({
    limit: 100,
    offset: 0,
    sort: { column: "idx", direction: "ascending" },
    filter: {
      journalId: {
        kind: "fk",
        op: "in",
        values: [journalID],
        labels: [],
      },
    },
  });
}

function entryQuery(voucherNo: string) {
  return body({
    limit: 100,
    offset: 0,
    filter: {
      voucherNo: { kind: "text", op: "eq", value: voucherNo },
    },
  });
}

async function createJournal(
  tokenHeaders: Record<string, string>,
  input: Record<string, unknown>,
) {
  const item = await request<Journal>(
    "/accounting/gl-journals",
    { method: "POST", headers: tokenHeaders, body: body(input) },
    201,
  );
  journalIDs.add(item.id);
  trackedIDs.add(item.id);
  return item;
}

async function createLine(
  tokenHeaders: Record<string, string>,
  input: Record<string, unknown>,
) {
  const item = await request<JournalLine>(
    "/accounting/gl-journal-lines",
    { method: "POST", headers: tokenHeaders, body: body(input) },
    201,
  );
  lineIDs.add(item.id);
  trackedIDs.add(item.id);
  return item;
}

async function setPermissions(
  adminHeaders: Record<string, string>,
  permissions: string[],
) {
  assert(roleID, "只读角色尚未创建");
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
  assert(userID, "只读用户尚未创建");
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
  for (const id of trackedIDs) {
    await db`DELETE FROM sys_audit_log WHERE record_id=${id}::uuid`;
  }
  for (const id of journalIDs) {
    await db`DELETE FROM acc_gl_entry WHERE voucher_type='acc.gl_journal' AND voucher_id=${id}::uuid`;
  }
  if (bankReconciliationID) {
    await db`DELETE FROM acc_bank_reconciliation WHERE id=${bankReconciliationID}::uuid`;
    bankReconciliationID = null;
  }
  if (bankTransactionID) {
    await db`DELETE FROM acc_bank_transaction WHERE id=${bankTransactionID}::uuid`;
    bankTransactionID = null;
  }
  if (bankAccountID) {
    await db`DELETE FROM acc_bank_account WHERE id=${bankAccountID}::uuid`;
    bankAccountID = null;
  }
  for (const id of lineIDs) {
    await db`DELETE FROM acc_gl_journal_line WHERE id=${id}::uuid`;
  }
  for (const id of journalIDs) {
    await db`DELETE FROM acc_gl_journal WHERE id=${id}::uuid`;
  }
  if (customerID) {
    await db`DELETE FROM sal_customers WHERE id=${customerID}::uuid`;
    customerID = null;
  }
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
  if (numberingRuleID) {
    await db`DELETE FROM sys_numbering_counter WHERE rule_id=${numberingRuleID}::uuid`;
    await db`DELETE FROM sys_numbering_rule WHERE id=${numberingRuleID}::uuid`;
    numberingRuleID = null;
  }
  for (const id of fixtureAccountIDs) {
    await db`DELETE FROM bas_account WHERE id=${id}::uuid`;
  }
  for (const id of fixtureCompanyIDs) {
    await db`DELETE FROM bas_company WHERE id=${id}::uuid`;
  }
  if (fixtureCurrencyID) {
    await db`DELETE FROM bas_currency WHERE id=${fixtureCurrencyID}::uuid`;
    fixtureCurrencyID = null;
  }
  // 上次进程被强制终止时内存中的 UUID 已丢失，仍按本脚本唯一前缀收口。
  await db`DELETE FROM sys_user_role WHERE user_id IN (SELECT id FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"})`;
  await db`DELETE FROM sys_user_company WHERE user_id IN (SELECT id FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"})`;
  await db`DELETE FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"}`;
  await db`DELETE FROM sys_role_permission WHERE role_id IN (SELECT id FROM sys_role WHERE code LIKE ${prefix + "%"})`;
  await db`DELETE FROM sys_role WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM acc_bank_reconciliation WHERE journal_id IN (SELECT id FROM acc_gl_journal WHERE voucher_no LIKE ${prefix + "%"})`;
  await db`DELETE FROM acc_bank_transaction WHERE summary LIKE ${prefix + "%"}`;
  await db`DELETE FROM acc_bank_account WHERE alias LIKE ${prefix + "%"}`;
  await db`DELETE FROM acc_gl_entry WHERE voucher_no LIKE ${prefix + "%"}`;
  await db`DELETE FROM acc_gl_journal_line WHERE journal_id IN (SELECT id FROM acc_gl_journal WHERE voucher_no LIKE ${prefix + "%"})`;
  await db`DELETE FROM acc_gl_journal WHERE voucher_no LIKE ${prefix + "%"}`;
  await db`DELETE FROM sal_customers WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_account WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_company WHERE code LIKE ${prefix + "%"}`;
  await db`DELETE FROM bas_currency WHERE iso_code LIKE ${prefix + "%"}`;
  await db`DELETE FROM sys_numbering_counter WHERE rule_id IN (SELECT id FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})`;
  await db`DELETE FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}`;
  await db`DELETE FROM sys_audit_log WHERE changes::text LIKE ${"%" + prefix + "%"}`;
}

async function assertCleanupZero() {
  const recordIDs = [...trackedIDs];
  const auditCount =
    recordIDs.length === 0
      ? 0
      : Number(
          (
            (await db`
              SELECT count(*)::int AS count
              FROM sys_audit_log
              WHERE record_id=ANY(${"{" + recordIDs.join(",") + "}"}::uuid[])
            `) as Array<{ count: number }>
          )[0]!.count,
        );
  const rows = (await db`
    SELECT
      (SELECT count(*) FROM acc_gl_journal WHERE voucher_no LIKE ${prefix + "%"})::int AS journals,
      (SELECT count(*) FROM acc_gl_journal_line l JOIN acc_gl_journal j ON j.id=l.journal_id WHERE j.voucher_no LIKE ${prefix + "%"})::int AS lines,
      (SELECT count(*) FROM acc_gl_entry WHERE voucher_no LIKE ${prefix + "%"})::int AS entries,
      (SELECT count(*) FROM sal_customers WHERE code LIKE ${prefix + "%"})::int AS customers,
      (SELECT count(*) FROM bas_account WHERE code LIKE ${prefix + "%"})::int AS accounts,
      (SELECT count(*) FROM bas_company WHERE code LIKE ${prefix + "%"})::int AS companies,
      (SELECT count(*) FROM bas_currency WHERE iso_code LIKE ${prefix + "%"})::int AS currencies,
      (SELECT count(*) FROM acc_bank_account WHERE alias LIKE ${prefix + "%"})::int AS bank_accounts,
      (SELECT count(*) FROM acc_bank_transaction WHERE summary LIKE ${prefix + "%"})::int AS bank_transactions,
      (SELECT count(*) FROM acc_bank_reconciliation r JOIN acc_gl_journal j ON j.id=r.journal_id WHERE j.voucher_no LIKE ${prefix + "%"})::int AS bank_reconciliations,
      (SELECT count(*) FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})::int AS numbering_rules,
      (SELECT count(*) FROM sys_numbering_counter c JOIN sys_numbering_rule r ON r.id=c.rule_id WHERE r.name LIKE ${prefix + "%"})::int AS numbering_counters,
      (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"})::int AS roles,
      (SELECT count(*) FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"})::int AS users
  `) as Array<Record<string, number>>;
  const residue = { ...rows[0]!, audits: auditCount };
  assert(
    Object.values(residue).every((value) => Number(value) === 0),
    `验收残留未归零: ${JSON.stringify(residue)}`,
  );
}

const adminHeaders = await loginAs(username, password);

try {
  await cleanup();
  await assertCleanupZero();

  // 测试库刻意不依赖演示数据：基础币种、两家公司和两科目均以 UUID/前缀自建。
  const currencies = (await db`
    INSERT INTO bas_currency(name,iso_code,symbol,active)
    VALUES (${prefix + "验收币种"},${prefix + "CUR"},'¤',true)
    RETURNING id::text AS id
  `) as RecordID[];
  fixtureCurrencyID = currencies[0]!.id;
  trackedIDs.add(fixtureCurrencyID);
  const companies = (await db`
    INSERT INTO bas_company(code,name,short_name,base_currency_id)
    VALUES
      (${prefix + "A"},${prefix + "验收公司A"},${prefix + "A"},${fixtureCurrencyID}::uuid),
      (${prefix + "B"},${prefix + "验收公司B"},${prefix + "B"},${fixtureCurrencyID}::uuid)
    RETURNING id::text AS id,code,name
  `) as Array<RecordID & { code: string; name: string }>;
  const companyA = companies.find((company) => company.code === `${prefix}A`)!;
  const companyB = companies.find((company) => company.code === `${prefix}B`)!;
  for (const company of companies) {
    fixtureCompanyIDs.add(company.id);
    trackedIDs.add(company.id);
  }
  const accounts = (await db`
    INSERT INTO bas_account(code,name,direction,is_group,active,company_id,currency_id,role)
    VALUES
      (${prefix + "1122"},${prefix + "应收账款"},'debit',false,true,${companyA.id}::uuid,${fixtureCurrencyID}::uuid,'receivable'),
      (${prefix + "1001"},${prefix + "库存现金"},'debit',false,true,${companyA.id}::uuid,${fixtureCurrencyID}::uuid,NULL)
    RETURNING id::text AS id,code,currency_id::text AS "currencyId"
  `) as Array<RecordID & { code: string; currencyId: string | null }>;
  const receivable = accounts.find(
    (account) => account.code === `${prefix}1122`,
  )!;
  const offset = accounts.find((account) => account.code === `${prefix}1001`)!;
  for (const account of accounts) {
    fixtureAccountIDs.add(account.id);
    trackedIDs.add(account.id);
  }
  const fixture: Fixture = {
    companyId: companyA.id,
    companyName: companyA.name,
    otherCompanyId: companyB.id,
    receivableAccountId: receivable.id,
    receivableCurrencyId: receivable.currencyId,
    offsetAccountId: offset.id,
    offsetCurrencyId: offset.currencyId,
  };
  const postingDate = "2026-07-26";
  const asOf = "2026-07-31";

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

  const activeJournalRules = (await db`
    SELECT id::text AS id
    FROM sys_numbering_rule
    WHERE resource='acc.gl_journal' AND enabled=true
  `) as RecordID[];
  assert(
    activeJournalRules.length === 0,
    "验收前已存在启用的 acc.gl_journal 编号规则；脚本拒绝覆盖现有配置",
  );
  await requestText(
    "/accounting/gl-journals",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        date: postingDate,
        companyId: fixture.companyId,
        remarks: `${prefix}无规则`,
      }),
    },
    409,
  );
  const failedAutoRows = (await db`
    SELECT count(*)::int AS count
    FROM acc_gl_journal
    WHERE remarks=${prefix + "无规则"}
  `) as Array<{ count: number }>;
  assert(Number(failedAutoRows[0]!.count) === 0, "无编号规则失败却落库");

  const numberingRule = await request<RecordID>(
    "/system/numbering/rules",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        resource: "acc.gl_journal",
        name: `${prefix}凭证编号`,
        segments: [
          { type: "text", value: `${prefix}AUTO-` },
          { type: "seq", padding: 3 },
        ],
        perCompany: true,
        enabled: true,
      }),
    },
    201,
  );
  numberingRuleID = numberingRule.id;
  trackedIDs.add(numberingRule.id);
  const autoJournal = await createJournal(adminHeaders, {
    date: postingDate,
    companyId: fixture.companyId,
    remarks: `${prefix}自动编号`,
  });
  assert(
    autoJournal.voucherNo === `${prefix}AUTO-001`,
    `凭证自动编号=${autoJournal.voucherNo}, want ${prefix}AUTO-001`,
  );
  await requestText(
    `/accounting/gl-journals/${autoJournal.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  await requestText(
    `/system/numbering/rules/${numberingRule.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  numberingRuleID = null;

  const customer = await request<RecordID & { name: string }>(
    "/sales/customers",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}C`,
        name: `${prefix}验收客户`,
        shortName: "PR-2.12",
      }),
    },
    201,
  );
  customerID = customer.id;
  trackedIDs.add(customer.id);

  // 跨公司草稿用于验证 CompanyScope；主凭证走完整头行生命周期。
  const otherJournal = await createJournal(adminHeaders, {
    voucherNo: `${prefix}-B`,
    date: postingDate,
    companyId: fixture.otherCompanyId,
    remarks: `${prefix}跨公司`,
  });
  const journal = await createJournal(adminHeaders, {
    voucherNo: `${prefix}-A`,
    date: postingDate,
    postingDate: null,
    companyId: fixture.companyId,
    remarks: `${prefix}创建`,
  });
  assert(
    journal.status === "DRAFT" &&
      journal.createdById !== null &&
      journal.company.id === fixture.companyId,
    "凭证创建状态、编写人或公司 join 错误",
  );
  const updatedJournal = await request<Journal>(
    `/accounting/gl-journals/${journal.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ remarks: `${prefix}已更新`, postingDate: null }),
    },
  );
  assert(
    updatedJournal.remarks === `${prefix}已更新` &&
      updatedJournal.postingDate === null,
    "凭证头更新/nullable 字段错误",
  );

  let debitLine = await createLine(adminHeaders, {
    journalId: journal.id,
    idx: 1,
    accountId: fixture.receivableAccountId,
    debit: "125.50",
    credit: "0",
    partyType: "CUSTOMER",
    partyId: customer.id,
    remarks: `${prefix}应收`,
  });
  const creditLine = await createLine(adminHeaders, {
    journalId: journal.id,
    idx: 2,
    accountId: fixture.offsetAccountId,
    debit: "0",
    credit: "125.50",
    remarks: `${prefix}对方`,
  });
  const temporaryLine = await createLine(adminHeaders, {
    journalId: journal.id,
    idx: 3,
    accountId: fixture.offsetAccountId,
    debit: "0",
    credit: "0",
    remarks: `${prefix}待删除`,
  });
  assert(
    debitLine.companyId === fixture.companyId &&
      debitLine.currencyId === fixture.receivableCurrencyId &&
      creditLine.currencyId === fixture.offsetCurrencyId,
    "凭证行 company/currency 服务端复制错误",
  );
  debitLine = await request<JournalLine>(
    `/accounting/gl-journal-lines/${debitLine.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({ remarks: `${prefix}应收已更新` }),
    },
  );
  assert(debitLine.remarks === `${prefix}应收已更新`, "凭证行更新失败");
  await requestText(
    `/accounting/gl-journal-lines/${temporaryLine.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );

  const lineList = await request<List<JournalLine>>(
    "/accounting/gl-journal-lines/query",
    { method: "POST", headers: adminHeaders, body: lineQuery(journal.id) },
  );
  assertDeepEqual(
    lineList.results.map((row) => row.id),
    [debitLine.id, creditLine.id],
    "凭证行 query/idx 默认顺序",
  );
  const gotLine = await request<JournalLine>(
    `/accounting/gl-journal-lines/${debitLine.id}`,
    { headers: adminHeaders },
  );
  assert(
    gotLine.journal.id === journal.id &&
      gotLine.account.id === fixture.receivableAccountId,
    "凭证行 get/join 错误",
  );

  // 单独覆盖草稿头删除与行 cascade；cascade 不应伪造行 destroy 审计。
  const deletedJournal = await createJournal(adminHeaders, {
    voucherNo: `${prefix}-DEL`,
    date: postingDate,
    companyId: fixture.companyId,
  });
  const cascadedLine = await createLine(adminHeaders, {
    journalId: deletedJournal.id,
    idx: 1,
    accountId: fixture.offsetAccountId,
    debit: "0",
    credit: "0",
  });
  await requestText(
    `/accounting/gl-journals/${deletedJournal.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  await requestText(
    `/accounting/gl-journal-lines/${cascadedLine.id}`,
    { headers: adminHeaders },
    404,
  );

  const audited = await request<Journal>(
    `/accounting/gl-journals/${journal.id}/audit`,
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ postingDate }),
    },
  );
  assert(
    audited.status === "AUDITED" &&
      audited.postingDate === postingDate &&
      audited.submittedAt !== null &&
      audited.submittedById !== null,
    "凭证审核状态/提交字段错误",
  );
  assertDecimal(audited.debitTotal, 125.5, "凭证借方合计");
  assertDecimal(audited.creditTotal, 125.5, "凭证贷方合计");

  const entries = await request<List<Entry>>(
    "/accounting/gl-entries/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: entryQuery(journal.voucherNo),
    },
  );
  assert(entries.count === 2, `审核分录条数=${entries.count}, want 2`);
  for (const entry of entries.results) {
    trackedIDs.add(entry.id);
    assert(
      entry.voucherType === "acc.gl_journal" &&
        entry.voucherId === journal.id &&
        entry.voucherNo === journal.voucherNo &&
        entry.companyId === fixture.companyId &&
        entry.postingDate.slice(0, 10) === postingDate &&
        !entry.isCancelled &&
        !entry.isReversed &&
        !entry.isReversal,
      `审核分录来源/生命周期字段错误: ${JSON.stringify(entry)}`,
    );
    assert(typeof entry.debit === "string", "分录 debit 必须是 string");
    assert(typeof entry.credit === "string", "分录 credit 必须是 string");
  }
  assert(
    entries.results[0]!.seq < entries.results[1]!.seq,
    "总账分录 seq 未按数据库序列递增",
  );
  const gotEntry = await request<Entry>(
    `/accounting/gl-entries/${entries.results[0]!.id}`,
    { headers: adminHeaders },
  );
  assert(gotEntry.voucherId === journal.id, "总账分录 get 错误");

  const reportBeforeCancel = await request<ARAPReport>(
    `/accounting/ar-ap-report?companyId=${fixture.companyId}&asOf=${asOf}`,
    { headers: adminHeaders },
  );
  const customerRow = reportBeforeCancel.rows.find(
    (row) => row.partyId === customer.id,
  );
  assert(customerRow, "应收应付报表缺少验收客户");
  assert(
    reportBeforeCancel.asOf === asOf &&
      reportBeforeCancel.roleAccounts.receivable?.some(
        (account) => account.id === fixture.receivableAccountId,
      ),
    "应收应付报表截至日/角色科目错误",
  );
  assertDecimal(customerRow.balances.receivable, 125.5, "报表应收余额");
  assertDecimal(customerRow.netReceivable, 125.5, "报表净应收");
  for (const key of [
    "unbilledReceivable",
    "receivable",
    "advanceReceived",
    "unbilledPayable",
    "payable",
    "advancePaid",
    "otherPayable",
  ]) {
    assert(
      typeof customerRow.balances[key] === "string",
      `报表 balances.${key} 必须返回 decimal string`,
    );
  }

  const role = await request<RecordID>(
    "/system/roles",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}READ`,
        name: `${prefix}财务只读`,
        enabled: true,
      }),
    },
    201,
  );
  roleID = role.id;
  trackedIDs.add(role.id);
  await setPermissions(adminHeaders, readPermissions);
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
        name: `${prefix}财务只读`,
        roleIds: [role.id],
        companyIds: [fixture.companyId],
      }),
    },
    201,
  );
  userID = limited.user.id;
  trackedIDs.add(limited.user.id);
  let readHeaders = await loginAs(limited.user.username, limited.password);

  for (const resource of resources) {
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

  // 所有写入口先授权后解码：畸形 JSON 仍必须是 403。
  for (const [method, path] of [
    ["POST", "/accounting/gl-journals"],
    ["PATCH", `/accounting/gl-journals/${journal.id}`],
    ["POST", `/accounting/gl-journals/${journal.id}/audit`],
    ["POST", `/accounting/gl-journals/${journal.id}/cancel`],
    ["POST", "/accounting/gl-journal-lines"],
    ["PATCH", `/accounting/gl-journal-lines/${debitLine.id}`],
  ] as const) {
    await requestText(
      path,
      { method, headers: readHeaders, body: "{" },
      403,
    );
  }
  for (const path of [
    `/accounting/gl-journals/${journal.id}`,
    `/accounting/gl-journal-lines/${debitLine.id}`,
  ]) {
    await requestText(
      path,
      { method: "DELETE", headers: readHeaders },
      403,
    );
  }

  // report 必须独立校验 acc.gl_entry:read。
  await setPermissions(adminHeaders, ["acc.gl_journal:read"]);
  readHeaders = await loginAs(limited.user.username, limited.password);
  await requestText(
    `/accounting/ar-ap-report?companyId=${fixture.companyId}&asOf=${asOf}`,
    { headers: readHeaders },
    403,
  );
  await setPermissions(adminHeaders, readPermissions);
  readHeaders = await loginAs(limited.user.username, limited.password);

  // 单公司：三资源只看 A，公司外 get 隐藏为 404，report 明确 403。
  const oneCompanyJournals = await request<List<Journal>>(
    "/accounting/gl-journals/query",
    {
      method: "POST",
      headers: readHeaders,
      body: journalQuery(),
    },
  );
  assertDeepEqual(
    oneCompanyJournals.results.map((row) => row.id),
    [journal.id],
    "单公司 journal scope",
  );
  const oneCompanyLines = await request<List<JournalLine>>(
    "/accounting/gl-journal-lines/query",
    { method: "POST", headers: readHeaders, body: lineQuery(journal.id) },
  );
  assert(oneCompanyLines.count === 2, "单公司 line scope");
  const oneCompanyEntries = await request<List<Entry>>(
    "/accounting/gl-entries/query",
    {
      method: "POST",
      headers: readHeaders,
      body: entryQuery(journal.voucherNo),
    },
  );
  assert(oneCompanyEntries.count === 2, "单公司 entry scope");
  await request<Journal>(
    `/accounting/gl-journals/${journal.id}`,
    { headers: readHeaders },
  );
  await request<JournalLine>(
    `/accounting/gl-journal-lines/${debitLine.id}`,
    { headers: readHeaders },
  );
  await request<Entry>(
    `/accounting/gl-entries/${entries.results[0]!.id}`,
    { headers: readHeaders },
  );
  await requestText(
    `/accounting/gl-journals/${otherJournal.id}`,
    { headers: readHeaders },
    404,
  );
  await requestText(
    `/accounting/ar-ap-report?companyId=${fixture.otherCompanyId}&asOf=${asOf}`,
    { headers: readHeaders },
    403,
  );

  // 多公司。
  await setCompanies(adminHeaders, [
    fixture.companyId,
    fixture.otherCompanyId,
  ]);
  readHeaders = await loginAs(limited.user.username, limited.password);
  const multiCompany = await request<List<Journal>>(
    "/accounting/gl-journals/query",
    {
      method: "POST",
      headers: readHeaders,
      body: journalQuery(),
    },
  );
  assertDeepEqual(
    multiCompany.results.map((row) => row.id).sort(),
    [journal.id, otherJournal.id].sort(),
    "多公司 journal scope",
  );

  // allCompanies：清空显式公司后仍能看到两家公司；必须重新登录刷新 actor。
  await setCompanies(adminHeaders, []);
  await db`UPDATE sys_user SET all_companies=true WHERE id=${userID}::uuid`;
  readHeaders = await loginAs(limited.user.username, limited.password);
  const allCompanies = await request<List<Journal>>(
    "/accounting/gl-journals/query",
    {
      method: "POST",
      headers: readHeaders,
      body: journalQuery(),
    },
  );
  assertDeepEqual(
    allCompanies.results.map((row) => row.id).sort(),
    [journal.id, otherJournal.id].sort(),
    "allCompanies journal scope",
  );
  await request<ARAPReport>(
    `/accounting/ar-ap-report?companyId=${fixture.companyId}&asOf=${asOf}`,
    { headers: readHeaders },
  );

  // 空公司集合 fail-closed。
  await db`UPDATE sys_user SET all_companies=false WHERE id=${userID}::uuid`;
  readHeaders = await loginAs(limited.user.username, limited.password);
  for (const [path, queryBody] of [
    ["/accounting/gl-journals/query", journalQuery()],
    ["/accounting/gl-journal-lines/query", lineQuery(journal.id)],
    ["/accounting/gl-entries/query", entryQuery(journal.voucherNo)],
  ] as const) {
    const result = await request<List<RecordID>>(path, {
      method: "POST",
      headers: readHeaders,
      body: queryBody,
    });
    assert(result.count === 0, `空公司集合未 fail-closed: ${path}`);
  }
  await requestText(
    `/accounting/ar-ap-report?companyId=${fixture.companyId}&asOf=${asOf}`,
    { headers: readHeaders },
    403,
  );

  // 已用于银行对账的凭证不得取消；解除引用后才允许进入终态。
  const bankAccounts = (await db`
    INSERT INTO acc_bank_account(
      alias,bank_name,holder_name,account_no,company_id,currency_id,account_id
    )
    VALUES (
      ${prefix + "验收账户"},${prefix + "验收银行"},${prefix + "持有人"},
      ${prefix + "NO"},${fixture.companyId}::uuid,${fixtureCurrencyID}::uuid,
      ${fixture.offsetAccountId}::uuid
    )
    RETURNING id::text AS id
  `) as RecordID[];
  bankAccountID = bankAccounts[0]!.id;
  trackedIDs.add(bankAccountID);
  const bankTransactions = (await db`
    INSERT INTO acc_bank_transaction(
      occurred_at,income,expense,balance,summary,company_id,bank_account_id,
      reconciled_amount,unreconciled_amount,reconcile_status
    )
    VALUES (
      ${postingDate + " 10:00:00"},'125.50',NULL,'125.50',
      ${prefix + "银行流水"},${fixture.companyId}::uuid,${bankAccountID}::uuid,
      '125.50','0','reconciled'
    )
    RETURNING id::text AS id
  `) as RecordID[];
  bankTransactionID = bankTransactions[0]!.id;
  trackedIDs.add(bankTransactionID);
  const reconciliations = (await db`
    INSERT INTO acc_bank_reconciliation(
      amount,company_id,bank_transaction_id,journal_id
    )
    VALUES (
      '125.50',${fixture.companyId}::uuid,${bankTransactionID}::uuid,
      ${journal.id}::uuid
    )
    RETURNING id::text AS id
  `) as RecordID[];
  bankReconciliationID = reconciliations[0]!.id;
  trackedIDs.add(bankReconciliationID);
  await requestText(
    `/accounting/gl-journals/${journal.id}/cancel`,
    { method: "POST", headers: adminHeaders },
    409,
  );
  const protectedJournal = await request<Journal>(
    `/accounting/gl-journals/${journal.id}`,
    { headers: adminHeaders },
  );
  assert(
    protectedJournal.status === "AUDITED",
    "银行对账阻断取消后凭证状态发生变化",
  );
  const protectedEntries = await request<List<Entry>>(
    "/accounting/gl-entries/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: entryQuery(journal.voucherNo),
    },
  );
  assert(
    protectedEntries.results.every((entry) => !entry.isCancelled),
    "银行对账阻断取消后分录被部分作废",
  );
  await db`DELETE FROM acc_bank_reconciliation WHERE id=${bankReconciliationID}::uuid`;
  bankReconciliationID = null;
  await db`DELETE FROM acc_bank_transaction WHERE id=${bankTransactionID}::uuid`;
  bankTransactionID = null;
  await db`DELETE FROM acc_bank_account WHERE id=${bankAccountID}::uuid`;
  bankAccountID = null;

  const cancelled = await request<Journal>(
    `/accounting/gl-journals/${journal.id}/cancel`,
    { method: "POST", headers: adminHeaders },
  );
  assert(cancelled.status === "CANCELLED", "凭证取消状态错误");
  const cancelledEntries = await request<List<Entry>>(
    "/accounting/gl-entries/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: entryQuery(journal.voucherNo),
    },
  );
  assert(
    cancelledEntries.count === 2 &&
      cancelledEntries.results.every((entry) => entry.isCancelled),
    "取消应保留两条明细并全组标记 isCancelled",
  );
  const reportAfterCancel = await request<ARAPReport>(
    `/accounting/ar-ap-report?companyId=${fixture.companyId}&asOf=${asOf}`,
    { headers: adminHeaders },
  );
  assert(
    !reportAfterCancel.rows.some((row) => row.partyId === customer.id),
    "取消分录仍进入应收应付报表",
  );

  const auditRows = (await db`
    SELECT resource,record_id::text AS "recordId",action_name AS "actionName"
    FROM sys_audit_log
    WHERE record_id=ANY(${"{" + [...trackedIDs].join(",") + "}"}::uuid[])
    ORDER BY inserted_at,id
  `) as Array<{ resource: string; recordId: string; actionName: string }>;
  for (const [resource, recordID, action] of [
    ["acc_gl_journal", journal.id, "create"],
    ["acc_gl_journal", journal.id, "update"],
    ["acc_gl_journal", journal.id, "audit"],
    ["acc_gl_journal", journal.id, "cancel"],
    ["acc_gl_journal_line", debitLine.id, "create"],
    ["acc_gl_journal_line", debitLine.id, "update"],
    ["acc_gl_journal_line", temporaryLine.id, "destroy"],
    ["acc_gl_journal", deletedJournal.id, "destroy"],
  ] as const) {
    assert(
      auditRows.some(
        (row) =>
          row.resource === resource &&
          row.recordId === recordID &&
          row.actionName === action,
      ),
      `缺少审计 ${resource}/${recordID}/${action}`,
    );
  }
  assert(
    !auditRows.some(
      (row) =>
        row.resource === "acc_gl_journal_line" &&
        row.recordId === cascadedLine.id &&
        row.actionName === "destroy",
    ),
    "删除凭证 cascade 不应伪造凭证行 destroy 审计",
  );
  assert(
    !auditRows.some((row) => row.resource === "acc_gl_entry"),
    "总账分录不应重复写通用审计",
  );

  await cleanup();
  await assertCleanupZero();
  console.log(
    "accounting REST acceptance ok: meta=6 permissions=9 " +
      "companyScope=single/multi/all/empty journalCRUD=1 lineCRUD=3 " +
      "audit=1 entries=2 arAp=1 cancel=1 cleanup=0",
  );
} finally {
  await cleanup();
  await db.close();
}
