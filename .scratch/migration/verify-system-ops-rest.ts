import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 10)
  .toUpperCase();
const prefix = `ZZR218${suffix}`;
const missingID = crypto.randomUUID();

type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type AuthHeaders = Record<string, string>;
type CreatedUser = {
  user: Row & { username: string };
  password: string;
};
type Fixture = {
  currencyId: string;
  companyId: string;
  otherCompanyId: string;
  customerId: string;
  supplierId: string;
  debitAccountId: string;
  creditAccountId: string;
  reconciliationId: string;
  invoiceId: string;
  globalAuditId: string;
  companyAuditId: string;
  otherAuditId: string;
  primaryTodoId: string;
  fillerTodoIds: string[];
  historyTodoIds: string[];
  otherTodoId: string;
};
type Todo = Row & {
  type: "ISSUE_INVOICE" | "RECEIVE_INVOICE";
  sourceType: string;
  sourceId: string;
  sourceNo: string;
  partyType: "CUSTOMER" | "SUPPLIER";
  partyId: string;
  partyName: string;
  amount: string;
  status: "ACTIVE" | "CLOSED";
  closedReason: "UNCONFIRM" | "INVOICE_AUDIT" | null;
  sourceChangedAt: string;
  closedAt: string | null;
  insertedAt: string;
  updatedAt: string;
  companyId: string;
  company: { id: string; name: string; shortName: string | null };
  createdById: string | null;
  draftInvoiceLinked: boolean;
  myReadAt: string | null;
  myDismissedAt: string | null;
  dismissed: boolean;
};

let roleId: string | null = null;
const userIds: string[] = [];
let graphqlCalls = 0;
let permissionFirst = 0;
let unavailableMeta = 0;
let readOnlySurface = 0;
let auditScopeChecks = 0;
let todoBehaviorChecks = 0;
let todoStateChecks = 0;
let internalInvariantChecks = 0;
let cleanupCount = -1;

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

async function snapshot(actor: "superadmin" | "read-only") {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.18",
      `sysAuditLogs.${actor}.grid.json`,
    ),
  ).json();
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

async function grantTodoPermissionFixture() {
  assert(roleId, "验收角色尚未创建");
  // PR-2.18 必须复用 acc.vat_invoice:create；VAT invoice 仍在后续迁移批次，
  // 当前 Go 权限目录尚未注册它。直接恢复一条迁移数据库中可合法既存的授权，
  // JWT 仍通过真实登录/权限加载边界取得该权限。
  await db`
    INSERT INTO sys_role_permission(role_id,permission)
    VALUES(${roleId}::uuid,'acc.vat_invoice:create')
  `;
}

async function expectPermissionFirst(path: string, init: RequestInit) {
  await requestText(path, init, 403);
  permissionFirst++;
}

async function expectUnavailable(path: string, init: RequestInit = {}) {
  const response = await rawRequest(path, init);
  const text = await response.text();
  assert(
    response.status === 404 || response.status === 405,
    `${init.method ?? "GET"} ${path} 应保持不公开，实际 ${response.status}: ${text}`,
  );
  unavailableMeta++;
}

async function expectNoWrite(path: string, init: RequestInit) {
  const response = await rawRequest(path, init);
  const text = await response.text();
  assert(
    response.status === 404 || response.status === 405,
    `${init.method ?? "GET"} ${path} 不应存在写入面，实际 ${response.status}: ${text}`,
  );
  readOnlySurface++;
}

async function queryTodos(
  auth: AuthHeaders,
  tab: "active" | "history" | "recent",
  includeDismissed = false,
  limit = 200,
  offset = 0,
) {
  return request<List<Todo>>("/todos/query", {
    method: "POST",
    headers: auth,
    body: body({ tab, includeDismissed, limit, offset }),
  });
}

async function createBaseFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    currencyId: crypto.randomUUID(),
    companyId: crypto.randomUUID(),
    otherCompanyId: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    supplierId: crypto.randomUUID(),
    debitAccountId: crypto.randomUUID(),
    creditAccountId: crypto.randomUUID(),
    reconciliationId: crypto.randomUUID(),
    invoiceId: crypto.randomUUID(),
    globalAuditId: crypto.randomUUID(),
    companyAuditId: crypto.randomUUID(),
    otherAuditId: crypto.randomUUID(),
    primaryTodoId: crypto.randomUUID(),
    fillerTodoIds: Array.from({ length: 9 }, () => crypto.randomUUID()),
    historyTodoIds: [crypto.randomUUID(), crypto.randomUUID()],
    otherTodoId: crypto.randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`
      INSERT INTO bas_currency(id,name,iso_code,symbol,active)
      VALUES(${fixture.currencyId}::uuid,${prefix + "验收币"},${"S" + suffix},'¤',true)
    `;
    await tx`
      INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
      VALUES
        (${fixture.companyId}::uuid,${"A" + suffix},${prefix + "验收公司"},${prefix + "公司"},${fixture.currencyId}::uuid),
        (${fixture.otherCompanyId}::uuid,${"B" + suffix},${prefix + "域外公司"},${prefix + "域外"},${fixture.currencyId}::uuid)
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
        id,code,name,direction,is_group,active,company_id,currency_id
      ) VALUES
        (${fixture.debitAccountId}::uuid,${"DA" + suffix},${prefix + "借方"},'debit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid),
        (${fixture.creditAccountId}::uuid,${"CA" + suffix},${prefix + "贷方"},'credit',false,true,${fixture.companyId}::uuid,${fixture.currencyId}::uuid)
    `;
  });
  return fixture;
}

async function createUser(
  admin: AuthHeaders,
  discriminator: string,
  companyIds: string[],
) {
  assert(roleId, "验收角色尚未创建");
  const created = await request<CreatedUser>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}${discriminator}`,
        name: `${prefix}${discriminator}用户`,
        roleIds: [roleId],
        companyIds,
      }),
    },
    201,
  );
  userIds.push(created.user.id);
  return created;
}

async function createSystemFixtures(fixture: Fixture, createdById: string) {
  await db.begin(async (tx) => {
    for (let index = 0; index < 52; index++) {
      const id =
        index === 0
          ? fixture.globalAuditId
          : index === 51
            ? fixture.companyAuditId
            : crypto.randomUUID();
      await tx`
        INSERT INTO sys_audit_log(
          id,resource,record_id,record_label,action_type,action_name,
          actor_id,actor_name,company_id,changes,inserted_at
        ) VALUES(
          ${id}::uuid,${prefix + ".audit"},${crypto.randomUUID()}::uuid,
          ${`${prefix}-AUD-${String(index).padStart(2, "0")}`},
          'update','update',${createdById}::uuid,${prefix + "验收操作人"},
          ${index === 0 ? null : fixture.companyId}::uuid,
          ${{
            secret: { from: "[FILTERED]", to: "[FILTERED]" },
            name: { from: "旧值", to: "新值" },
          }}::jsonb,
          ${`2026-07-26 00:00:${String(index).padStart(2, "0")}`}::timestamp
        )
      `;
    }
    await tx`
      INSERT INTO sys_audit_log(
        id,resource,record_id,record_label,action_type,action_name,
        company_id,changes,inserted_at
      ) VALUES(
        ${fixture.otherAuditId}::uuid,${prefix + ".audit"},${crypto.randomUUID()}::uuid,
        ${prefix + "-AUD-OTHER"},'destroy','destroy',${fixture.otherCompanyId}::uuid,
        '{"name":{"from":"域外"}}'::jsonb,'2026-07-26 00:01:00'::timestamp
      )
    `;
    await tx`
      INSERT INTO sal_reconciliation(
        id,reconciliation_no,reconciliation_type,party_type,party_id,status,
        company_id,debit_account_id,credit_account_id
      ) VALUES(
        ${fixture.reconciliationId}::uuid,${prefix + "-SR"},'regular','customer',
        ${fixture.customerId}::uuid,'confirmed',${fixture.companyId}::uuid,
        ${fixture.debitAccountId}::uuid,${fixture.creditAccountId}::uuid
      )
    `;
    await tx`
      INSERT INTO acc_vat_invoice(
        id,direction,party_type,party_id,invoice_kind,status,company_id,
        sal_reconciliation_id
      ) VALUES(
        ${fixture.invoiceId}::uuid,'outbound','customer',${fixture.customerId}::uuid,
        'normal','draft',${fixture.companyId}::uuid,${fixture.reconciliationId}::uuid
      )
    `;
    await tx`
      INSERT INTO sys_todo(
        id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
        source_changed_at,inserted_at,updated_at,company_id,created_by_id
      ) VALUES(
        ${fixture.primaryTodoId}::uuid,'issue_invoice','sales.reconciliation',
        ${fixture.reconciliationId}::uuid,${prefix + "-SR"},'customer',
        ${fixture.customerId}::uuid,321.45,'active',
        '2026-07-26 10:00:00'::timestamp,'2026-07-26 10:00:00'::timestamp,
        '2026-07-26 10:00:00'::timestamp,${fixture.companyId}::uuid,${createdById}::uuid
      )
    `;
    for (const [index, id] of fixture.fillerTodoIds.entries()) {
      await tx`
        INSERT INTO sys_todo(
          id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
          source_changed_at,inserted_at,updated_at,company_id,created_by_id
        ) VALUES(
          ${id}::uuid,'receive_invoice','purchase.reconciliation',
          ${crypto.randomUUID()}::uuid,${`${prefix}-PR-${index}`},'supplier',
          ${fixture.supplierId}::uuid,${String(100 + index)},'active',
          ${`2026-07-26 09:00:${String(59 - index).padStart(2, "0")}`}::timestamp,
          ${`2026-07-26 09:00:${String(59 - index).padStart(2, "0")}`}::timestamp,
          ${`2026-07-26 09:00:${String(59 - index).padStart(2, "0")}`}::timestamp,
          ${fixture.companyId}::uuid,${createdById}::uuid
        )
      `;
    }
    await tx`
      INSERT INTO sys_todo(
        id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
        closed_reason,source_changed_at,closed_at,inserted_at,updated_at,
        company_id,created_by_id
      ) VALUES
        (
          ${fixture.historyTodoIds[0]}::uuid,'issue_invoice','sales.reconciliation',
          ${crypto.randomUUID()}::uuid,${prefix + "-H-UNCONFIRM"},'customer',
          ${fixture.customerId}::uuid,10,'closed','unconfirm',
          '2026-07-25 08:00:00'::timestamp,'2026-07-25 09:00:00'::timestamp,
          '2026-07-25 08:00:00'::timestamp,'2026-07-25 09:00:00'::timestamp,
          ${fixture.companyId}::uuid,${createdById}::uuid
        ),
        (
          ${fixture.historyTodoIds[1]}::uuid,'receive_invoice','purchase.reconciliation',
          ${crypto.randomUUID()}::uuid,${prefix + "-H-AUDIT"},'supplier',
          ${fixture.supplierId}::uuid,20,'closed','invoice_audit',
          '2026-07-25 07:00:00'::timestamp,'2026-07-25 09:30:00'::timestamp,
          '2026-07-25 07:00:00'::timestamp,'2026-07-25 09:30:00'::timestamp,
          ${fixture.companyId}::uuid,${createdById}::uuid
        )
    `;
    await tx`
      INSERT INTO sys_todo(
        id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
        source_changed_at,company_id
      ) VALUES(
        ${fixture.otherTodoId}::uuid,'issue_invoice','sales.reconciliation',
        ${crypto.randomUUID()}::uuid,${prefix + "-OTHER"},'customer',
        ${fixture.customerId}::uuid,999,'active',(now() AT TIME ZONE 'utc'),
        ${fixture.otherCompanyId}::uuid
      )
    `;
  });
  const auditShapes = await db`
    SELECT
      count(*)::int AS count,
      count(*) FILTER (WHERE jsonb_typeof(changes)='object')::int AS objects
    FROM sys_audit_log WHERE resource=${prefix + ".audit"}
  `;
  assert(
    Number(auditShapes[0]?.count) === 53 &&
      Number(auditShapes[0]?.objects) === 53,
    "Audit 验收夹具 changes 必须全部为 JSONB object",
  );
}

async function verifyInternalDatabaseInvariants(fixture: Fixture) {
  const sourceID = crypto.randomUUID();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const insert = (id: string) => db`
    INSERT INTO sys_todo(
      id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
      source_changed_at,company_id
    ) VALUES(
      ${id}::uuid,'issue_invoice','sales.reconciliation',${sourceID}::uuid,
      ${prefix + "-RACE"},'customer',${fixture.customerId}::uuid,1,'active',
      (now() AT TIME ZONE 'utc'),${fixture.companyId}::uuid
    )
  `;
  const raced = await Promise.allSettled(ids.map(insert));
  assert(
    raced.filter((item) => item.status === "fulfilled").length === 1 &&
      raced.filter((item) => item.status === "rejected").length === 1,
    "sys_todo partial unique 未阻止并发双开",
  );
  internalInvariantChecks++;

  await db`
    UPDATE sys_todo
    SET status='closed',closed_reason='unconfirm',
        closed_at=(now() AT TIME ZONE 'utc'),updated_at=(now() AT TIME ZONE 'utc')
    WHERE source_type='sales.reconciliation'
      AND source_id=${sourceID}::uuid AND status='active'
  `;
  await insert(crypto.randomUUID());
  const history = await db`
    SELECT status,count(*)::int AS count
    FROM sys_todo WHERE source_id=${sourceID}::uuid
    GROUP BY status ORDER BY status
  `;
  same(
    history.map((row) => ({ status: row.status, count: Number(row.count) })),
    [
      { status: "active", count: 1 },
      { status: "closed", count: 1 },
    ],
    "内部 close 后复活必须新开且保留历史",
  );
  internalInvariantChecks++;

  const cascadeTodoID = crypto.randomUUID();
  const cascadeUserID = userIds[0]!;
  await db`
    INSERT INTO sys_todo(
      id,type,source_type,source_id,source_no,party_type,party_id,amount,status,
      source_changed_at,company_id
    ) VALUES(
      ${cascadeTodoID}::uuid,'issue_invoice','sales.reconciliation',
      ${crypto.randomUUID()}::uuid,${prefix + "-CASCADE"},'customer',
      ${fixture.customerId}::uuid,1,'active',(now() AT TIME ZONE 'utc'),
      ${fixture.companyId}::uuid
    )
  `;
  await db`
    INSERT INTO sys_todo_state(todo_id,user_id,read_at)
    VALUES(${cascadeTodoID}::uuid,${cascadeUserID}::uuid,(now() AT TIME ZONE 'utc'))
  `;
  await db`DELETE FROM sys_todo WHERE id=${cascadeTodoID}::uuid`;
  const cascade = await db`
    SELECT count(*)::int AS count FROM sys_todo_state
    WHERE todo_id=${cascadeTodoID}::uuid
  `;
  assert(Number(cascade[0]?.count) === 0, "Todo 删除没有级联清理 TodoState");
  internalInvariantChecks++;
}

async function cleanup(fixture: Fixture | null) {
  try {
    if (fixture) {
      await db`DELETE FROM sys_todo WHERE company_id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`;
      await db`DELETE FROM acc_vat_invoice WHERE id=${fixture.invoiceId}::uuid`;
      await db`DELETE FROM sal_reconciliation WHERE id=${fixture.reconciliationId}::uuid`;
      await db`DELETE FROM bas_account WHERE id IN (${fixture.debitAccountId}::uuid,${fixture.creditAccountId}::uuid)`;
      await db`DELETE FROM sys_audit_log WHERE resource=${prefix + ".audit"} OR record_label LIKE ${prefix + "%"}`;
    }
    for (const id of userIds) {
      await db`DELETE FROM sys_user_role WHERE user_id=${id}::uuid`;
      await db`DELETE FROM sys_user_company WHERE user_id=${id}::uuid`;
      await db`DELETE FROM sys_user WHERE id=${id}::uuid`;
    }
    userIds.length = 0;
    if (roleId) {
      await db`DELETE FROM sys_role_permission WHERE role_id=${roleId}::uuid`;
      await db`DELETE FROM sys_role WHERE id=${roleId}::uuid`;
      roleId = null;
    }
    if (fixture) {
      await db`DELETE FROM sal_customers WHERE id=${fixture.customerId}::uuid`;
      await db`DELETE FROM pur_supplier WHERE id=${fixture.supplierId}::uuid`;
      await db`DELETE FROM bas_company WHERE id IN (${fixture.companyId}::uuid,${fixture.otherCompanyId}::uuid)`;
      await db`DELETE FROM bas_currency WHERE id=${fixture.currencyId}::uuid`;
    }
    const remaining = await db`
      SELECT
        (SELECT count(*) FROM bas_company WHERE name LIKE ${prefix + "%"}) +
        (SELECT count(*) FROM bas_currency WHERE name LIKE ${prefix + "%"}) +
        (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"}) +
        (SELECT count(*) FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}) +
        (SELECT count(*) FROM sys_audit_log WHERE resource=${prefix + ".audit"} OR record_label LIKE ${prefix + "%"}) +
        (SELECT count(*) FROM sys_todo WHERE source_no LIKE ${prefix + "%"})
        AS count
    `;
    cleanupCount = Number(remaining[0]?.count ?? -1);
  } finally {
    await db.close();
  }
}

let fixture: Fixture | null = null;
let acceptanceSummary = "";
try {
  fixture = await createBaseFixture();
  const admin = await login(
    process.env.E2E_ADMIN_USERNAME ?? "admin",
    process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password",
  );

  const superMeta = await request<{ grid: unknown; record?: unknown }>(
    "/meta/resources/sysAuditLogs",
    { headers: admin },
  );
  same(
    superMeta.grid,
    await snapshot("superadmin"),
    "sysAuditLogs superadmin Meta",
  );
  assert(
    !("record" in superMeta),
    "sysAuditLogs 不应发明迁移前不存在的独立 RecordMeta",
  );
  for (const resource of ["sysTodos", "sysTodoStates"]) {
    await expectUnavailable(`/meta/resources/${resource}`, { headers: admin });
  }

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
  const actorAUser = await createUser(admin, "a", [fixture.companyId]);
  const actorBUser = await createUser(admin, "b", [fixture.companyId]);
  const noCompanyUser = await createUser(admin, "none", []);
  await createSystemFixtures(fixture, actorAUser.user.id);

  const denied = await login(actorAUser.user.username, actorAUser.password);
  await expectPermissionFirst("/meta/resources/sysAuditLogs", {
    headers: denied,
  });
  await expectPermissionFirst("/system/audit-logs/query", {
    method: "POST",
    headers: denied,
    body: "{",
  });
  await expectPermissionFirst(`/system/audit-logs/${missingID}`, {
    headers: denied,
  });
  await expectPermissionFirst("/todos/query", {
    method: "POST",
    headers: denied,
    body: "{",
  });
  await expectPermissionFirst(`/todos/${missingID}/read`, {
    method: "POST",
    headers: denied,
    body: "{",
  });
  await expectPermissionFirst(`/todos/${missingID}/dismiss`, {
    method: "POST",
    headers: denied,
    body: "{",
  });
  await expectPermissionFirst("/todos/unread-count", { headers: denied });

  await setPermissions(admin, ["sys.audit_log:read"]);
  await grantTodoPermissionFixture();
  const actorA = await login(actorAUser.user.username, actorAUser.password);
  const actorB = await login(actorBUser.user.username, actorBUser.password);
  const noCompany = await login(
    noCompanyUser.user.username,
    noCompanyUser.password,
  );

  const readMeta = await request<{ grid: unknown; record?: unknown }>(
    "/meta/resources/sysAuditLogs",
    { headers: actorA },
  );
  same(
    readMeta.grid,
    await snapshot("read-only"),
    "sysAuditLogs read-only Meta",
  );
  assert(
    !("record" in readMeta),
    "read-only sysAuditLogs 不应发明独立 RecordMeta",
  );
  for (const auth of [actorA, noCompany]) {
    for (const resource of ["sysTodos", "sysTodoStates"]) {
      await expectUnavailable(`/meta/resources/${resource}`, { headers: auth });
    }
  }

  const auditFilter = {
    resource: { kind: "text", op: "eq", value: `${prefix}.audit` },
  };
  const companyAudit = await request<List<Row>>("/system/audit-logs/query", {
    method: "POST",
    headers: actorA,
    body: body({ filter: auditFilter }),
  });
  assert(
    companyAudit.count === 52 && companyAudit.results.length === 50,
    `Audit 默认 limit 应为 50 且 company actor 可见 global+A，实际 ${companyAudit.count}/${companyAudit.results.length}`,
  );
  assert(
    companyAudit.results[0]?.recordLabel === `${prefix}-AUD-51`,
    "Audit 默认排序不是 insertedAt DESC",
  );
  auditScopeChecks += 2;

  const globalOnly = await request<List<Row>>("/system/audit-logs/query", {
    method: "POST",
    headers: noCompany,
    body: body({ limit: 200, filter: auditFilter }),
  });
  assert(
    globalOnly.count === 1 &&
      globalOnly.results[0]?.id === fixture.globalAuditId,
    "空公司授权的 Audit actor 应仍可见 global 行且不可见公司行",
  );
  auditScopeChecks++;

  const superAudit = await request<List<Row>>("/system/audit-logs/query", {
    method: "POST",
    headers: admin,
    body: body({ limit: 200, filter: auditFilter }),
  });
  assert(superAudit.count === 53, "superadmin 应跨公司看到全部 Audit 行");
  auditScopeChecks++;

  const auditItem = await request<Row>(
    `/system/audit-logs/${fixture.companyAuditId}`,
    { headers: actorA },
  );
  same(
    auditItem.changes,
    {
      name: { from: "旧值", to: "新值" },
      secret: { from: "[FILTERED]", to: "[FILTERED]" },
    },
    "Audit changes REST object/snake_case/敏感值",
  );
  await requestText(
    `/system/audit-logs/${fixture.otherAuditId}`,
    { headers: actorA },
    404,
  );
  auditScopeChecks += 2;

  for (const [path, init] of [
    ["/system/audit-logs", { method: "POST", headers: admin, body: "{}" }],
    [
      `/system/audit-logs/${fixture.companyAuditId}`,
      { method: "PATCH", headers: admin, body: "{}" },
    ],
    [
      `/system/audit-logs/${fixture.companyAuditId}`,
      { method: "DELETE", headers: admin },
    ],
    ["/todos", { method: "POST", headers: admin, body: "{}" }],
    [`/todos/${fixture.primaryTodoId}`, { headers: admin }],
    [
      `/todos/${fixture.primaryTodoId}`,
      { method: "PATCH", headers: admin, body: "{}" },
    ],
    [`/todos/${fixture.primaryTodoId}`, { method: "DELETE", headers: admin }],
    ["/todo-states", { method: "POST", headers: admin, body: "{}" }],
    [`/todo-states/${missingID}`, { headers: admin }],
    ["/system/todo-states", { method: "POST", headers: admin, body: "{}" }],
    [`/system/todo-states/${missingID}`, { headers: admin }],
    ["/todos/states", { headers: admin }],
  ] as const) {
    await expectNoWrite(path, init);
  }

  const activeA = await queryTodos(actorA, "active");
  assert(
    activeA.count === 10 && activeA.results.length === 10,
    `active tab 应只返回公司内 10 条 active，实际 ${activeA.count}/${activeA.results.length}`,
  );
  assert(
    activeA.results.every((todo) => todo.status === "ACTIVE"),
    "active tab 混入非 ACTIVE",
  );
  const primary = activeA.results.find(
    (todo) => todo.id === fixture!.primaryTodoId,
  );
  assert(primary, "active tab 缺少主验收 Todo");
  same(
    {
      type: primary.type,
      sourceType: primary.sourceType,
      partyType: primary.partyType,
      partyName: primary.partyName,
      amount: primary.amount,
      status: primary.status,
      closedReason: primary.closedReason,
      company: primary.company,
      draftInvoiceLinked: primary.draftInvoiceLinked,
      myReadAt: primary.myReadAt,
      myDismissedAt: primary.myDismissedAt,
      dismissed: primary.dismissed,
    },
    {
      type: "ISSUE_INVOICE",
      sourceType: "sales.reconciliation",
      partyType: "CUSTOMER",
      partyName: `${prefix}验收客户`,
      amount: "321.45",
      status: "ACTIVE",
      closedReason: null,
      company: {
        id: fixture.companyId,
        name: `${prefix}验收公司`,
        shortName: `${prefix}公司`,
      },
      draftInvoiceLinked: true,
      myReadAt: null,
      myDismissedAt: null,
      dismissed: false,
    },
    "Todo uppercase wire/sourceType/五计算字段/company DTO",
  );
  todoBehaviorChecks += 3;

  const noCompanyTodos = await queryTodos(noCompany, "active");
  assert(
    noCompanyTodos.count === 0,
    "Todo CompanyScope 必须对空公司 actor fail-closed",
  );
  todoBehaviorChecks++;

  const recent = await queryTodos(actorA, "recent", false, 200);
  assert(
    recent.count === 10 &&
      recent.results.length === 8 &&
      recent.results[0]?.id === fixture.primaryTodoId,
    "recent 必须只取 active、强制 limit=8 且默认倒序",
  );
  todoBehaviorChecks++;

  const history = await queryTodos(actorA, "history");
  assert(
    history.count === 2 &&
      history.results.every((todo) => todo.status === "CLOSED"),
    "history tab 必须只返回 CLOSED",
  );
  same(
    history.results
      .map((todo) => todo.closedReason)
      .sort((a, b) => String(a).localeCompare(String(b))),
    ["INVOICE_AUDIT", "UNCONFIRM"],
    "Todo closedReason uppercase",
  );
  todoBehaviorChecks += 2;

  const initialUnreadA = await request<{ count: number }>(
    "/todos/unread-count",
    { headers: actorA },
  );
  const initialUnreadB = await request<{ count: number }>(
    "/todos/unread-count",
    { headers: actorB },
  );
  assert(
    initialUnreadA.count === 10 && initialUnreadB.count === 10,
    "两个用户初始未读数应彼此独立且均为 10",
  );
  todoStateChecks++;

  const marked = await request<Todo>(`/todos/${fixture.primaryTodoId}/read`, {
    method: "POST",
    headers: actorA,
  });
  assert(
    marked.id === fixture.primaryTodoId &&
      marked.myReadAt !== null &&
      marked.myDismissedAt === null &&
      marked.dismissed === false,
    "mark read 未返回当前用户已读痕迹",
  );
  const afterReadA = await request<{ count: number }>("/todos/unread-count", {
    headers: actorA,
  });
  const afterReadB = await request<{ count: number }>("/todos/unread-count", {
    headers: actorB,
  });
  assert(
    afterReadA.count === 9 && afterReadB.count === 10,
    "mark read 只应减少当前用户未读数",
  );
  todoStateChecks += 2;

  const dismissedID = fixture.fillerTodoIds[0]!;
  const dismissed = await request<Todo>(`/todos/${dismissedID}/dismiss`, {
    method: "POST",
    headers: actorA,
  });
  assert(
    dismissed.myReadAt !== null &&
      dismissed.myDismissedAt !== null &&
      dismissed.dismissed === true,
    "dismiss 必须同时写 read/dismiss/reset basis",
  );
  const hidden = await queryTodos(actorA, "active");
  const included = await queryTodos(actorA, "active", true);
  assert(
    hidden.count === 9 &&
      !hidden.results.some((todo) => todo.id === dismissedID) &&
      included.count === 10 &&
      included.results.find((todo) => todo.id === dismissedID)?.dismissed ===
        true,
    "includeDismissed=false/true 行为不一致",
  );
  const actorBView = await queryTodos(actorB, "active");
  const actorBDismissed = actorBView.results.find(
    (todo) => todo.id === dismissedID,
  );
  assert(
    actorBDismissed &&
      actorBDismissed.myReadAt === null &&
      actorBDismissed.myDismissedAt === null &&
      actorBDismissed.dismissed === false,
    "用户 A 的忽略痕迹泄漏给用户 B",
  );
  todoStateChecks += 3;

  const concurrentID = fixture.fillerTodoIds[1]!;
  const concurrent = await Promise.all([
    rawRequest(`/todos/${concurrentID}/read`, {
      method: "POST",
      headers: actorB,
    }),
    rawRequest(`/todos/${concurrentID}/dismiss`, {
      method: "POST",
      headers: actorB,
    }),
  ]);
  const concurrentBodies = await Promise.all(
    concurrent.map((response) => response.text()),
  );
  assert(
    concurrent.every((response) => response.status === 200),
    `并发首次 mark/dismiss 应串行落一条痕迹，实际 ${concurrent
      .map((response, index) => `${response.status}:${concurrentBodies[index]}`)
      .join(" | ")}`,
  );
  const stateRows = await db`
    SELECT count(*)::int AS count,max(read_at) AS read_at,
           max(dismissed_at) AS dismissed_at,max(reset_basis_at) AS reset_basis_at
    FROM sys_todo_state
    WHERE todo_id=${concurrentID}::uuid AND user_id=${actorBUser.user.id}::uuid
  `;
  assert(
    Number(stateRows[0]?.count) === 1 &&
      stateRows[0]?.read_at &&
      stateRows[0]?.dismissed_at &&
      stateRows[0]?.reset_basis_at,
    "并发 mark/dismiss 没有收敛为一条完整用户痕迹",
  );
  todoStateChecks += 2;

  await db`
    UPDATE sys_todo
    SET source_changed_at=source_changed_at+interval '1 minute'
    WHERE id=${dismissedID}::uuid
  `;
  const resetVisible = await queryTodos(actorA, "active");
  const reset = resetVisible.results.find((todo) => todo.id === dismissedID);
  assert(
    reset &&
      reset.myDismissedAt !== null &&
      reset.dismissed === false &&
      resetVisible.count === 10,
    "sourceChangedAt 变化后有效忽略没有复位",
  );
  todoStateChecks++;

  await verifyInternalDatabaseInvariants(fixture);

  acceptanceSummary =
    `system ops REST acceptance ok: meta=2 unavailableMeta=${unavailableMeta} ` +
    `permissionFirst=${permissionFirst} readOnly=${readOnlySurface} ` +
    `auditScope=${auditScopeChecks} todoBehavior=${todoBehaviorChecks} ` +
    `todoState=${todoStateChecks} internalInvariants=${internalInvariantChecks}`;
} finally {
  await cleanup(fixture);
}

assert(cleanupCount === 0, `清理后仍有 ${cleanupCount} 条 PR-2.18 验收夹具`);
assert(graphqlCalls === 0, `验收脚本发出了 ${graphqlCalls} 次 GraphQL 请求`);
console.log(
  `${acceptanceSummary} graphql=${graphqlCalls} cleanup=${cleanupCount}`,
);
