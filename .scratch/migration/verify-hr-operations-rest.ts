import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const db = new SQL(databaseURL);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const prefix = `ZZR219${suffix}`;
const missingID = crypto.randomUUID();

type Headers = Record<string, string>;
type Row = Record<string, unknown> & { id: string };
type List<T> = { count: number; results: T[] };
type MetaDocument = { name: string; grid: Record<string, unknown> };
type Employee = Row & {
  code: string;
  name: string;
  attendanceNo: string | null;
};
type AttendanceImport = Row & {
  status: "PARSED" | "FAILED" | "IMPORTED";
  error: string | null;
  totalRows: number | null;
  badRows: number | null;
  dupRows: number | null;
  matchedRows: number | null;
  unmatchedRows: number | null;
  importedCount: number | null;
  skippedExistingRows: number | null;
  skippedUnmatchedRows: number | null;
  autoCreatedCount: number | null;
  punchCount: number;
};
type AttendanceDay = Row & {
  date: string;
  morningIn: string | null;
  morningOut: string | null;
  afternoonIn: string | null;
  afternoonOut: string | null;
  normalHours: string;
  overtimeHours: string;
  bonusWorkday: string;
  status: "OK" | "MISSING";
  employeeId: string;
};
type Correction = Row & {
  date: string;
  times: string[];
  note: string | null;
  employeeId: string;
  createdById: string | null;
};
type Payroll = Row & {
  month: string;
  workdays: string;
  attendanceDays: number;
  missingDays: number;
  overtimeHours: string;
  dailyWage: string;
  baseAmount: string;
  allowance: string;
  bonus: string;
  fine: string;
  loanDeduction: string;
  payable: string;
  status: "PENDING" | "PAID";
  remarks: string | null;
  employeeId: string;
  paidTotal: string | null;
};
type Payment = Row & {
  month: string | null;
  paidOn: string;
  amount: string;
  kind: "NORMAL" | "SUPPLEMENT";
  payrollId: string;
  employeeId: string | null;
};
type Loan = Row & {
  kind: "BORROW" | "REPAY";
  occurredOn: string;
  amount: string;
  employeeId: string;
  payrollId: string | null;
};

const resourceNames = [
  "hrAttendancePunches",
  "hrAttendanceImports",
  "hrAttendanceDays",
  "hrAttendanceCorrections",
  "hrPayrolls",
  "hrPayrollPayments",
  "hrEmployeeLoans",
] as const;
const fileIDs = new Set<string>();
const recordIDs = new Set<string>();
const employeeIDs = new Set<string>();
let readRoleID: string | null = null;
let importRoleID: string | null = null;
let readUserID: string | null = null;
let importUserID: string | null = null;
let numberingRuleID: string | null = null;
let graphqlCalls = 0;
let metaChecks = 0;
let permissionFirst = 0;
let unavailableRoutes = 0;
let importChecks = 0;
let attendanceChecks = 0;
let correctionChecks = 0;
let payrollChecks = 0;
let paymentChecks = 0;
let loanChecks = 0;
let auditChecks = 0;
let concurrencyChecks = 0;
let cleanupCount = -1;
let storageID: string | null = null;
let previousDefaultStorageID: string | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function body(value: unknown) {
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

async function login(name: string, secret: string) {
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
) {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.19",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

async function expectPermissionFirst(
  path: string,
  init: RequestInit,
) {
  await requestText(path, init, 403);
  permissionFirst++;
}

async function expectUnavailable(path: string, init: RequestInit) {
  const response = await rawRequest(path, init);
  const text = await response.text();
  assert(
    response.status === 404 || response.status === 405,
    `${init.method ?? "GET"} ${path} 应保持内部，实际 ${response.status}: ${text}`,
  );
  unavailableRoutes++;
}

async function uploadDat(
  headers: Headers,
  label: string,
  content: string,
) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([content], { type: "text/plain" }),
    `${prefix}-${label}.dat`,
  );
  const response = await rawRequest("/files", {
    method: "POST",
    headers: { Authorization: headers.Authorization },
    body: form,
  });
  const text = await response.text();
  assert(response.status === 201, `上传 ${label}: ${response.status} ${text}`);
  const result = JSON.parse(text) as { file: { id: string } };
  fileIDs.add(result.file.id);
  return result.file.id;
}

async function createEmployee(
  admin: Headers,
  code: string,
  name: string,
  attendanceNo: string,
  dailyWage: string,
  monthlyAllowance: string,
) {
  const employee = await request<Employee>(
    "/hr/employees",
    {
      method: "POST",
      headers: admin,
      body: body({
        code,
        name,
        attendanceNo,
        dailyWage,
        monthlyAllowance,
      }),
    },
    201,
  );
  employeeIDs.add(employee.id);
  recordIDs.add(employee.id);
  return employee;
}

async function createImport(admin: Headers, fileId: string) {
  const item = await request<AttendanceImport>(
    "/hr/attendance-imports",
    {
      method: "POST",
      headers: admin,
      body: body({ fileId }),
    },
    201,
  );
  recordIDs.add(item.id);
  return item;
}

async function query<T>(
  headers: Headers,
  path: string,
  filter: Record<string, unknown> = {},
  sort?: { column: string; direction: string },
) {
  return request<List<T>>(path, {
    method: "POST",
    headers,
    body: body({ limit: 200, offset: 0, filter, sort }),
  });
}

async function audits(resource: string, recordId: string) {
  return (await db`
    SELECT action_name AS "actionName", action_type AS "actionType", changes
      FROM sys_audit_log
     WHERE resource=${resource} AND record_id=${recordId}::uuid
     ORDER BY inserted_at,id
  `) as Array<{
    actionName: string;
    actionType: string;
    changes: Record<string, unknown>;
  }>;
}

async function setupStorage() {
  const previous = (await db`
    SELECT id::text AS id FROM sys_storage WHERE is_default=true LIMIT 1
  `) as Array<{ id: string }>;
  previousDefaultStorageID = previous[0]?.id ?? null;
  const rows = (await db.begin(async (tx) => {
    await tx`UPDATE sys_storage SET is_default=false WHERE is_default=true`;
    return tx`
      INSERT INTO sys_storage (name,label,kind,root,is_default)
      VALUES (
        ${prefix.toLowerCase()},
        ${prefix + "验收本地存储"},
        'local',
        ${`/tmp/${prefix.toLowerCase()}-files`},
        true
      )
      RETURNING id::text AS id
    `;
  })) as Array<{ id: string }>;
  storageID = rows[0]!.id;
}

async function teardownStorage() {
  if (!storageID) return;
  await db.begin(async (tx) => {
    await tx`UPDATE sys_storage SET is_default=false WHERE id=${storageID}::uuid`;
    await tx`DELETE FROM sys_storage WHERE id=${storageID}::uuid`;
    if (previousDefaultStorageID) {
      await tx`UPDATE sys_storage SET is_default=true WHERE id=${previousDefaultStorageID}::uuid`;
    }
  });
  storageID = null;
}

async function cleanup(admin?: Headers) {
  await db.begin(async (tx) => {
    // 验收 fixture 仅用 prefix 辨识；所有内部直写都局限于这些行，且按 FK 逆序强清理。
    // 已经通过 REST 删除的记录无法再由业务表反查，因此也按本次运行收集到的精确 ID 清审计。
    await tx`DELETE FROM sys_audit_log WHERE record_label LIKE ${prefix + "%"}`;
    for (const id of recordIDs) {
      await tx`DELETE FROM sys_audit_log WHERE record_id=${id}::uuid`;
    }
    await tx`DELETE FROM sys_audit_log WHERE record_id IN (
      SELECT p.id FROM hr_payroll_payment p JOIN hr_employees e ON e.id=p.employee_id
       WHERE e.code LIKE ${prefix + "%"}
      UNION SELECT l.id FROM hr_employee_loan l JOIN hr_employees e ON e.id=l.employee_id
       WHERE e.code LIKE ${prefix + "%"}
      UNION SELECT p.id FROM hr_payroll p JOIN hr_employees e ON e.id=p.employee_id
       WHERE e.code LIKE ${prefix + "%"}
      UNION SELECT c.id FROM hr_attendance_correction c JOIN hr_employees e ON e.id=c.employee_id
       WHERE e.code LIKE ${prefix + "%"}
      UNION SELECT i.id FROM hr_attendance_import i JOIN sys_file f ON f.id=i.file_id
       WHERE f.filename LIKE ${prefix + "%"}
      UNION SELECT e.id FROM hr_employees e WHERE e.code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_payroll_payment WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_employee_loan WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_payroll WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_attendance_correction WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_attendance_day WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_attendance_punch WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_attendance_import WHERE file_id IN (
      SELECT id FROM sys_file WHERE filename LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM hr_employees WHERE code LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sys_user_role WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_user_company WHERE user_id IN (
      SELECT id FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}
    )`;
    await tx`DELETE FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"}`;
    await tx`DELETE FROM sys_role_permission WHERE role_id IN (
      SELECT id FROM sys_role WHERE code LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM sys_role WHERE code LIKE ${prefix + "%"}`;
    await tx`DELETE FROM sys_numbering_counter WHERE rule_id IN (
      SELECT id FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}
    )`;
    await tx`DELETE FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"}`;
  });
  if (admin) {
    for (const id of fileIDs) {
      const response = await rawRequest(`/files/${id}`, {
        method: "DELETE",
        headers: admin,
      });
      if (response.status !== 204 && response.status !== 404) {
        await response.body?.cancel();
      }
    }
  }
  await db`DELETE FROM sys_file WHERE filename LIKE ${prefix + "%"}`;
  // REST 文件删除自身会写审计，必须在文件清理完成后再清一次验收标签。
  await db`DELETE FROM sys_audit_log WHERE record_label LIKE ${prefix + "%"}`;
  const rows = (await db`
    SELECT
      (SELECT count(*) FROM hr_employees WHERE code LIKE ${prefix + "%"})::int AS employees,
      (SELECT count(*) FROM hr_attendance_import i JOIN sys_file f ON f.id=i.file_id
        WHERE f.filename LIKE ${prefix + "%"})::int AS imports,
      (SELECT count(*) FROM sys_file WHERE filename LIKE ${prefix + "%"})::int AS files,
      (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"})::int AS roles,
      (SELECT count(*) FROM sys_user WHERE username LIKE ${prefix.toLowerCase() + "%"})::int AS users,
      (SELECT count(*) FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})::int AS rules,
      (SELECT count(*) FROM sys_audit_log WHERE record_label LIKE ${prefix + "%"})::int AS audits
  `) as Array<Record<string, number>>;
  cleanupCount = Object.values(rows[0]!).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  assert(cleanupCount === 0, `HR 验收 cleanup=${cleanupCount}: ${JSON.stringify(rows[0])}`);
}

const adminLogin = await request<{ token: string; user: { id: string } }>(
  "/auth/login",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({ username, password }),
  },
);
const admin = authHeaders(adminLogin.token);

try {
  await cleanup(admin);
  await setupStorage();

  const superMeta = new Map<string, MetaDocument>();
  for (const resource of resourceNames) {
    const document = await request<MetaDocument>(
      `/meta/resources/${resource}`,
      { headers: admin },
    );
    superMeta.set(resource, document);
    same(
      document.grid,
      await snapshot(resource, "superadmin"),
      `${resource} superadmin GridMeta`,
    );
    metaChecks++;
  }

  const readRole = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({
        code: `${prefix}READ`,
        name: `${prefix}只读`,
        enabled: true,
      }),
    },
    201,
  );
  readRoleID = readRole.id;
  await request(`/system/roles/${readRole.id}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({
      permissions: [
        "hr.attendance_punch:read",
        "hr.attendance_day:read",
        "hr.attendance_correction:read",
        "hr.payroll:read",
        "hr.payroll_payment:read",
        "hr.employee_loan:read",
        "hr.employee:read",
        "sys.file:read",
        "sys.user:read",
      ],
    }),
  });
  const readUser = await request<{
    user: Row & { username: string };
    password: string;
  }>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}reader`,
        name: `${prefix}只读用户`,
        roleIds: [readRole.id],
        companyIds: [],
      }),
    },
    201,
  );
  readUserID = readUser.user.id;
  const reader = await login(readUser.user.username, readUser.password);
  const readerCompanies = (await db`
    SELECT count(*)::int AS count FROM sys_user_company
     WHERE user_id=${readUser.user.id}::uuid
  `) as Array<{ count: number }>;
  assert(readerCompanies[0]!.count === 0, "全局只读用户意外绑定公司");

  for (const resource of resourceNames) {
    const document = await request<MetaDocument>(
      `/meta/resources/${resource}`,
      { headers: reader },
    );
    same(
      document.grid,
      await snapshot(resource, "read-only"),
      `${resource} read-only GridMeta`,
    );
    metaChecks++;
  }

  const importRole = await request<Row>(
    "/system/roles",
    {
      method: "POST",
      headers: admin,
      body: body({
        code: `${prefix}IMPORT`,
        name: `${prefix}仅导入`,
        enabled: true,
      }),
    },
    201,
  );
  importRoleID = importRole.id;
  await request(`/system/roles/${importRole.id}/permissions`, {
    method: "PUT",
    headers: admin,
    body: body({
      permissions: [
        "hr.attendance_punch:import",
        "hr.employee:read",
        "sys.file:read",
      ],
    }),
  });
  const importUser = await request<{
    user: Row & { username: string };
    password: string;
  }>(
    "/system/users",
    {
      method: "POST",
      headers: admin,
      body: body({
        username: `${prefix.toLowerCase()}importer`,
        name: `${prefix}导入用户`,
        roleIds: [importRole.id],
        companyIds: [],
      }),
    },
    201,
  );
  importUserID = importUser.user.id;
  const importer = await login(importUser.user.username, importUser.password);

  const permissionCases: Array<[string, RequestInit]> = [
    ["/hr/attendance-imports/query", { method: "POST", headers: reader, body: "{" }],
    ["/hr/attendance-imports", { method: "POST", headers: reader, body: "{" }],
    [`/hr/attendance-imports/${missingID}/import`, { method: "POST", headers: reader, body: "{" }],
    [`/hr/attendance-imports/${missingID}`, { method: "DELETE", headers: reader }],
    ["/hr/attendance-days/recalc", { method: "POST", headers: reader, body: "{" }],
    ["/hr/attendance-corrections", { method: "POST", headers: reader, body: "{" }],
    [`/hr/attendance-corrections/${missingID}`, { method: "PATCH", headers: reader, body: "{" }],
    [`/hr/attendance-corrections/${missingID}`, { method: "DELETE", headers: reader }],
    ["/hr/payrolls", { method: "POST", headers: reader, body: "{" }],
    ["/hr/payrolls/generate", { method: "POST", headers: reader, body: "{" }],
    [`/hr/payrolls/${missingID}`, { method: "PATCH", headers: reader, body: "{" }],
    [`/hr/payrolls/${missingID}/refresh`, { method: "POST", headers: reader, body: "{" }],
    [`/hr/payrolls/${missingID}`, { method: "DELETE", headers: reader }],
    ["/hr/payroll-payments", { method: "POST", headers: reader, body: "{" }],
    ["/hr/payroll-payments/pay-remaining", { method: "POST", headers: reader, body: "{" }],
    [`/hr/payroll-payments/${missingID}`, { method: "DELETE", headers: reader }],
    ["/hr/employee-loans", { method: "POST", headers: reader, body: "{" }],
    [`/hr/employee-loans/${missingID}`, { method: "PATCH", headers: reader, body: "{" }],
    [`/hr/employee-loans/${missingID}`, { method: "DELETE", headers: reader }],
  ];
  for (const [path, init] of permissionCases) {
    await expectPermissionFirst(path, init);
  }

  for (const [path, init] of [
    ["/hr/attendance-punches", { method: "POST", headers: admin, body: "{}" }],
    [`/hr/attendance-punches/${missingID}`, { method: "DELETE", headers: admin }],
    ["/hr/attendance-days", { method: "POST", headers: admin, body: "{}" }],
    [`/hr/attendance-days/${missingID}`, { method: "PATCH", headers: admin, body: "{}" }],
    [`/hr/payrolls/${missingID}/mark-paid`, { method: "POST", headers: admin, body: "{}" }],
    [`/hr/payrolls/${missingID}/mark-pending`, { method: "POST", headers: admin, body: "{}" }],
    [`/hr/payroll-payments/${missingID}`, { method: "PATCH", headers: admin, body: "{}" }],
    ["/hr/employee-loans/auto-repay", { method: "POST", headers: admin, body: "{}" }],
  ] as Array<[string, RequestInit]>) {
    await expectUnavailable(path, init);
  }

  const employeeA = await createEmployee(
    admin,
    `${prefix}E1`,
    `${prefix}甲员工`,
    `${suffix}01`,
    "100.1",
    "10",
  );
  const employeeB = await createEmployee(
    admin,
    `${prefix}E2`,
    `${prefix}乙员工`,
    `${suffix}02`,
    "88.8",
    "8",
  );
  const employeeC = await createEmployee(
    admin,
    `${prefix}E3`,
    `${prefix}丙员工`,
    `${suffix}03`,
    "66.6",
    "6",
  );

  const rule = await request<Row>(
    "/system/numbering/rules",
    {
      method: "POST",
      headers: admin,
      body: body({
        resource: "hr.employee",
        name: `${prefix}自动员工编号`,
        segments: [
          { type: "text", value: `${prefix}AUTO-` },
          { type: "seq", padding: 3 },
        ],
        perCompany: false,
        enabled: true,
      }),
    },
    201,
  );
  numberingRuleID = rule.id;
  recordIDs.add(rule.id);

  const primaryFile = await uploadDat(
    admin,
    "primary",
    [
      `${employeeA.attendanceNo} 2098-01-02 08:01:00`,
      `${employeeA.attendanceNo}\t2098-01-02 11:59:00 1 0`,
      `${employeeA.attendanceNo} 2098-01-02 13:00:00`,
      `${employeeA.attendanceNo} 2098-01-02 20:31:00`,
      `${employeeA.attendanceNo} 2098-01-02 20:31:00`,
      `BAD-LINE`,
      `${suffix}99 2098-01-02 09:00:00`,
    ].join("\n"),
  );
  const parsed = await createImport(admin, primaryFile);
  assert(
    parsed.status === "PARSED" &&
      parsed.totalRows === 7 &&
      parsed.badRows === 1 &&
      parsed.dupRows === 1 &&
      parsed.matchedRows === 4 &&
      parsed.unmatchedRows === 1 &&
      parsed.punchCount === 0,
    `导入预览统计错误: ${JSON.stringify(parsed)}`,
  );
  importChecks += 6;
  await request(
    "/hr/attendance-imports",
    {
      method: "POST",
      headers: admin,
      body: body({ fileId: primaryFile }),
    },
    409,
  );
  importChecks++;
  const imported = await request<AttendanceImport>(
    `/hr/attendance-imports/${parsed.id}/import`,
    {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    },
  );
  assert(
    imported.status === "IMPORTED" &&
      imported.importedCount === 4 &&
      imported.skippedUnmatchedRows === 1 &&
      imported.autoCreatedCount === 0 &&
      imported.punchCount === 4,
    `执行导入统计错误: ${JSON.stringify(imported)}`,
  );
  importChecks += 4;

  const punches = await query<Row>(
    reader,
    "/hr/attendance-punches/query",
    {
      employeeId: {
        kind: "fk",
        op: "in",
        values: [employeeA.id],
      },
    },
    { column: "punchedAt", direction: "ascending" },
  );
  assert(punches.count === 4, `打卡数=${punches.count}`);
  for (const punch of punches.results) {
    assert(!("companyId" in punch), "全局打卡意外出现 companyId");
    assert(
      typeof punch.punchedAt === "string" &&
        String(punch.punchedAt).endsWith("Z"),
      "打卡 UTC wire 错误",
    );
  }
  attendanceChecks += 3;
  const days = await query<AttendanceDay>(
    reader,
    "/hr/attendance-days/query",
    {
      employeeId: { kind: "fk", op: "in", values: [employeeA.id] },
      date: { kind: "date", op: "eq", value: "2098-01-02" },
    },
  );
  assert(days.count === 1, "导入未自动生成日考勤");
  const day = days.results[0]!;
  assert(
    day.morningIn === "08:01:00" &&
      day.morningOut === "11:59:00" &&
      day.afternoonIn === "13:00:00" &&
      day.afternoonOut === "20:31:00" &&
      day.normalHours === "7.5" &&
      day.overtimeHours === "3.5" &&
      day.bonusWorkday === "0.5" &&
      day.status === "OK",
    `日计算边界错误: ${JSON.stringify(day)}`,
  );
  attendanceChecks += 8;
  const summary = await request<
    Array<{
      employeeId: string;
      normalHours: string;
      overtimeHours: string;
      bonusWorkdays: string;
      workdays: string;
    }>
  >("/hr/attendance-days/month-summary?month=2098-01", {
    headers: reader,
  });
  const employeeSummary = summary.find((row) => row.employeeId === employeeA.id);
  assert(
    employeeSummary?.normalHours === "7.5" &&
      employeeSummary.overtimeHours === "3.5" &&
      employeeSummary.bonusWorkdays === "0.5" &&
      employeeSummary.workdays === "1.4375",
    `月汇总错误: ${JSON.stringify(employeeSummary)}`,
  );
  attendanceChecks += 4;
  await request(
    "/hr/attendance-days/recalc",
    {
      method: "POST",
      headers: admin,
      body: body({ dateFrom: "2098-01-02", dateTo: "2098-01-01" }),
    },
    400,
  );
  const recalc = await request<{ count: number }>(
    "/hr/attendance-days/recalc",
    {
      method: "POST",
      headers: admin,
      body: body({ dateFrom: "2098-01-02", dateTo: "2098-01-02" }),
    },
  );
  assert(recalc.count === 1, `重算 count=${recalc.count}`);
  attendanceChecks += 2;

  const failedFile = await uploadDat(
    admin,
    "all-bad",
    "BAD-LINE\nalso bad",
  );
  const failedImport = await createImport(admin, failedFile);
  assert(
    failedImport.status === "FAILED" &&
      failedImport.totalRows === null &&
      failedImport.badRows === null &&
      typeof failedImport.error === "string" &&
      failedImport.error.includes("共 2 行均无法识别") &&
      failedImport.punchCount === 0,
    `全坏文件未持久化可读失败: ${JSON.stringify(failedImport)}`,
  );
  const repeatedFailedImport = await createImport(admin, failedFile);
  assert(
    repeatedFailedImport.status === "FAILED",
    "FAILED 批次错误参与 sha256 防重",
  );
  importChecks += 7;

  const unmatchedFile = await uploadDat(
    admin,
    "all-unmatched",
    `${suffix}98 2098-02-01 08:00:00`,
  );
  const unmatchedBatch = await createImport(admin, unmatchedFile);
  const unmatchedImported = await request<AttendanceImport>(
    `/hr/attendance-imports/${unmatchedBatch.id}/import`,
    {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    },
  );
  assert(
    unmatchedImported.status === "IMPORTED" &&
      unmatchedImported.importedCount === 0 &&
      unmatchedImported.skippedUnmatchedRows === 1 &&
      unmatchedImported.punchCount === 0,
    `全未匹配导入错误: ${JSON.stringify(unmatchedImported)}`,
  );
  importChecks += 4;

  const autoNo = `${suffix}AUTO`;
  const autoFile = await uploadDat(
    admin,
    "auto",
    `${autoNo} 2098-02-03 08:00:00\n${autoNo} 2098-02-03 17:00:00`,
  );
  const autoBatch = await createImport(admin, autoFile);
  await request(
    `/hr/attendance-imports/${autoBatch.id}/import`,
    {
      method: "POST",
      headers: importer,
      body: body({ autoCreateEmployees: true }),
    },
    403,
  );
  const noAuto = (await db`
    SELECT count(*)::int AS count FROM hr_employees WHERE attendance_no=${autoNo}
  `) as Array<{ count: number }>;
  assert(Number(noAuto[0]!.count) === 0, "双权限失败却创建员工");
  const stillParsed = await request<AttendanceImport>(
    `/hr/attendance-imports/${autoBatch.id}`,
    { headers: admin },
  );
  assert(stillParsed.status === "PARSED", "双权限失败却改变批次状态");
  importChecks += 3;
  const autoImported = await request<AttendanceImport>(
    `/hr/attendance-imports/${autoBatch.id}/import`,
    {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: true }),
    },
  );
  assert(
    autoImported.autoCreatedCount === 1 &&
      autoImported.importedCount === 2,
    "自动建员工统计错误",
  );
  const autoEmployees = (await db`
    SELECT id::text AS id,code,name FROM hr_employees WHERE attendance_no=${autoNo}
  `) as Array<{ id: string; code: string; name: string }>;
  assert(
    autoEmployees.length === 1 &&
      autoEmployees[0]!.name === "[未知]" &&
      autoEmployees[0]!.code.startsWith(`${prefix}AUTO-`),
    `自动员工错误: ${JSON.stringify(autoEmployees)}`,
  );
  employeeIDs.add(autoEmployees[0]!.id);
  recordIDs.add(autoEmployees[0]!.id);
  importChecks += 4;

  const concurrentFile = await uploadDat(
    admin,
    "concurrent",
    `${employeeC.attendanceNo} 2098-03-04 08:00:00\n${employeeC.attendanceNo} 2098-03-04 17:00:00`,
  );
  const concurrentBatch = await createImport(admin, concurrentFile);
  const concurrentResponses = await Promise.all([
    rawRequest(`/hr/attendance-imports/${concurrentBatch.id}/import`, {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    }),
    rawRequest(`/hr/attendance-imports/${concurrentBatch.id}/import`, {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    }),
  ]);
  const concurrentStatuses = concurrentResponses.map((response) => response.status);
  assert(
    concurrentStatuses.filter((status) => status === 200).length === 1 &&
      concurrentStatuses.some((status) => status === 409),
    `同批并发状态=${concurrentStatuses.join(",")}`,
  );
  concurrencyChecks++;

  const uniqueTime = `${employeeC.attendanceNo} 2098-04-04 08:00:00`;
  const uniqueFileA = await uploadDat(
    admin,
    "unique-a",
    `${uniqueTime}\nBAD-A`,
  );
  const uniqueFileB = await uploadDat(
    admin,
    "unique-b",
    `${uniqueTime}\nBAD-B`,
  );
  const uniqueBatchA = await createImport(admin, uniqueFileA);
  const uniqueBatchB = await createImport(admin, uniqueFileB);
  const uniqueResponses = await Promise.all([
    rawRequest(`/hr/attendance-imports/${uniqueBatchA.id}/import`, {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    }),
    rawRequest(`/hr/attendance-imports/${uniqueBatchB.id}/import`, {
      method: "POST",
      headers: admin,
      body: body({ autoCreateEmployees: false }),
    }),
  ]);
  const uniqueStatuses = uniqueResponses.map((response) => response.status);
  assert(
    uniqueStatuses.filter((status) => status === 200).length === 1 &&
      uniqueStatuses.filter((status) => status === 409).length === 1,
    `不同批次 unique 并发状态=${uniqueStatuses.join(",")}`,
  );
  const uniqueStates = await Promise.all([
    request<AttendanceImport>(
      `/hr/attendance-imports/${uniqueBatchA.id}`,
      { headers: admin },
    ),
    request<AttendanceImport>(
      `/hr/attendance-imports/${uniqueBatchB.id}`,
      { headers: admin },
    ),
  ]);
  assert(
    uniqueStates.filter((item) => item.status === "IMPORTED").length === 1 &&
      uniqueStates.filter((item) => item.status === "PARSED").length === 1,
    `unique 冲突方未整事务回滚: ${JSON.stringify(uniqueStates)}`,
  );
  const uniquePunches = (await db`
    SELECT count(*)::int AS count
      FROM hr_attendance_punch
     WHERE employee_id=${employeeC.id}::uuid
       AND punched_at='2098-04-04T00:00:00Z'::timestamptz
  `) as Array<{ count: number }>;
  assert(uniquePunches[0]!.count === 1, "unique 并发产生重复或丢失打卡");
  concurrencyChecks += 3;

  const correction = await request<Correction>(
    "/hr/attendance-corrections",
    {
      method: "POST",
      headers: admin,
      body: body({
        employeeId: employeeB.id,
        date: "2098-01-05",
        times: ["17:45:00", "08:10:59", "12:00:00", "08:10:59"],
        note: `${prefix}补卡`,
      }),
    },
    201,
  );
  recordIDs.add(correction.id);
  same(
    correction.times,
    ["08:10:59", "12:00:00", "17:45:00"],
    "补卡时刻规整",
  );
  assert(correction.createdById === adminLogin.user.id, "补卡录入人错误");
  correctionChecks += 2;
  const correctedDays = await query<AttendanceDay>(
    admin,
    "/hr/attendance-days/query",
    {
      employeeId: { kind: "fk", values: [employeeB.id] },
      date: { kind: "date", op: "eq", value: "2098-01-05" },
    },
  );
  assert(
    correctedDays.results[0]?.status === "MISSING" &&
      correctedDays.results[0]?.normalHours === "4" &&
      correctedDays.results[0]?.overtimeHours === "1.5",
    `补卡日计算错误: ${JSON.stringify(correctedDays.results[0])}`,
  );
  correctionChecks += 3;
  const moved = await request<Correction>(
    `/hr/attendance-corrections/${correction.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({
        date: "2098-01-06",
        times: ["08:00:00", "12:30:00", "17:00:00"],
        note: null,
      }),
    },
  );
  assert(moved.date === "2098-01-06" && moved.note === null, "补卡换日/清备注错误");
  const oldDay = await query<AttendanceDay>(
    admin,
    "/hr/attendance-days/query",
    {
      employeeId: { kind: "fk", values: [employeeB.id] },
      date: { kind: "date", op: "eq", value: "2098-01-05" },
    },
  );
  assert(oldDay.count === 0, "补卡换日未清旧日");
  correctionChecks += 2;

  const cCorrection = await request<Correction>(
    "/hr/attendance-corrections",
    {
      method: "POST",
      headers: admin,
      body: body({
        employeeId: employeeC.id,
        date: "2098-01-07",
        times: ["08:00:00", "12:00:00", "13:00:00", "17:00:00"],
      }),
    },
    201,
  );
  recordIDs.add(cCorrection.id);

  const loan = await request<Loan>(
    "/hr/employee-loans",
    {
      method: "POST",
      headers: admin,
      body: body({
        employeeId: employeeA.id,
        kind: "BORROW",
        occurredOn: "2098-01-10",
        amount: "100",
        remarks: `${prefix}借款`,
      }),
    },
    201,
  );
  recordIDs.add(loan.id);
  assert(loan.kind === "BORROW" && loan.amount === "100", "借款 wire 错误");
  loanChecks += 2;

  const payroll = await request<Payroll>(
    "/hr/payrolls",
    {
      method: "POST",
      headers: admin,
      body: body({
        employeeId: employeeA.id,
        month: "2098-01",
        workdays: "2.345",
        attendanceDays: 2,
        missingDays: 0,
        overtimeHours: "3.5",
        dailyWage: "100.1",
        allowance: "10",
        bonus: "5",
        fine: "3",
        loanDeduction: "2",
        remarks: `${prefix}工资`,
      }),
    },
    201,
  );
  recordIDs.add(payroll.id);
  assert(
    payroll.baseAmount === "234.73" &&
      payroll.payable === "244.73" &&
      payroll.status === "PENDING" &&
      payroll.paidTotal === null &&
      !("companyId" in payroll),
    `工资公式/wire 错误: ${JSON.stringify(payroll)}`,
  );
  payrollChecks += 5;

  const normal = await request<Payment>(
    "/hr/payroll-payments",
    {
      method: "POST",
      headers: admin,
      body: body({
        payrollId: payroll.id,
        paidOn: "2098-01-31",
        amount: "50",
        remarks: `${prefix}首发`,
      }),
    },
    201,
  );
  recordIDs.add(normal.id);
  assert(normal.kind === "NORMAL" && normal.month === "2098-01", "NORMAL 判别错误");
  const supplement = await request<Payment>(
    "/hr/payroll-payments",
    {
      method: "POST",
      headers: admin,
      body: body({
        payrollId: payroll.id,
        paidOn: "2098-02-01",
        amount: "-10",
        remarks: `${prefix}冲回`,
      }),
    },
    201,
  );
  recordIDs.add(supplement.id);
  assert(supplement.kind === "SUPPLEMENT" && supplement.amount === "-10", "负数补发错误");
  const remaining = await request<Payment>(
    "/hr/payroll-payments/pay-remaining",
    {
      method: "POST",
      headers: admin,
      body: body({
        payrollId: payroll.id,
        paidOn: "2098-02-02",
        remarks: `${prefix}补齐`,
      }),
    },
    201,
  );
  recordIDs.add(remaining.id);
  assert(remaining.kind === "SUPPLEMENT" && remaining.amount === "204.73", "payRemaining 错误");
  paymentChecks += 5;
  await request(
    `/hr/payrolls/${payroll.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ remarks: `${prefix}已发不可改` }),
    },
    409,
  );
  await request(
    `/hr/payrolls/${payroll.id}/refresh`,
    { method: "POST", headers: admin },
    409,
  );
  await request(
    `/hr/payrolls/${payroll.id}`,
    { method: "DELETE", headers: admin },
    409,
  );
  payrollChecks += 3;
  const automaticLoans = await query<Loan>(
    admin,
    "/hr/employee-loans/query",
    { payrollId: { kind: "fk", values: [payroll.id] } },
  );
  assert(
    automaticLoans.count === 1 &&
      automaticLoans.results[0]?.kind === "REPAY" &&
      automaticLoans.results[0]?.amount === "2",
    "借款自动归还错误",
  );
  const automaticLoan = automaticLoans.results[0]!;
  recordIDs.add(automaticLoan.id);
  await request(
    `/hr/employee-loans/${automaticLoan.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ amount: "1" }),
    },
    409,
  );
  await request(
    `/hr/employee-loans/${automaticLoan.id}`,
    { method: "DELETE", headers: admin },
    409,
  );
  loanChecks += 4;
  const balances = await request<
    Array<{ employeeId: string; borrowed: string; repaid: string; balance: string }>
  >("/hr/employee-loans/balances", { headers: admin });
  const balanceA = balances.find((item) => item.employeeId === employeeA.id);
  assert(
    balanceA?.borrowed === "100" &&
      balanceA.repaid === "2" &&
      balanceA.balance === "98",
    `借款余额错误: ${JSON.stringify(balanceA)}`,
  );
  loanChecks += 3;

  await request<void>(
    `/hr/payroll-payments/${remaining.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  await request<void>(
    `/hr/payroll-payments/${normal.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  const pendingWithSupplement = await request<Payroll>(
    `/hr/payrolls/${payroll.id}`,
    { headers: admin },
  );
  assert(
    pendingWithSupplement.status === "PENDING" &&
      pendingWithSupplement.paidTotal === "-10",
    "删除 NORMAL 回退/保留 supplement 错误",
  );
  await request(
    `/hr/payrolls/${payroll.id}`,
    { method: "DELETE", headers: admin },
    409,
  );
  const repayAgain = await request<Payment>(
    "/hr/payroll-payments/pay-remaining",
    {
      method: "POST",
      headers: admin,
      body: body({ payrollId: payroll.id, paidOn: "2098-02-03" }),
    },
    201,
  );
  recordIDs.add(repayAgain.id);
  assert(repayAgain.kind === "NORMAL" && repayAgain.amount === "254.73", "回退后 payRemaining 错误");
  paymentChecks += 4;

  const insufficient = await request<Payroll>(
    "/hr/payrolls",
    {
      method: "POST",
      headers: admin,
      body: body({
        employeeId: employeeB.id,
        month: "2098-02",
        workdays: "1",
        attendanceDays: 1,
        missingDays: 0,
        overtimeHours: "0",
        dailyWage: "100",
        allowance: "0",
        bonus: "0",
        fine: "0",
        loanDeduction: "999",
      }),
    },
    201,
  );
  recordIDs.add(insufficient.id);
  const paymentAuditBefore = (await db`
    SELECT count(*)::int AS count FROM sys_audit_log
     WHERE resource='hr_payroll_payment'
  `) as Array<{ count: number }>;
  await request(
    "/hr/payroll-payments",
    {
      method: "POST",
      headers: admin,
      body: body({
        payrollId: insufficient.id,
        paidOn: "2098-02-28",
        amount: "1",
      }),
    },
    409,
  );
  const insufficientPayments = await query<Payment>(
    admin,
    "/hr/payroll-payments/query",
    { payrollId: { kind: "fk", values: [insufficient.id] } },
  );
  assert(insufficientPayments.count === 0, "余额不足失败却落发放");
  const insufficientAfter = await request<Payroll>(
    `/hr/payrolls/${insufficient.id}`,
    { headers: admin },
  );
  assert(insufficientAfter.status === "PENDING", "余额不足失败却翻工资状态");
  paymentChecks += 3;

  const generated = await request<{ created: number; skipped: number }>(
    "/hr/payrolls/generate",
    {
      method: "POST",
      headers: admin,
      body: body({ month: "2098-01" }),
    },
  );
  assert(generated.created >= 2 && generated.skipped >= 1, `generate=${JSON.stringify(generated)}`);
  payrollChecks += 2;
  const cPayrolls = await query<Payroll>(
    admin,
    "/hr/payrolls/query",
    {
      employeeId: { kind: "fk", values: [employeeC.id] },
      month: { kind: "text", op: "eq", value: "2098-01" },
    },
  );
  assert(cPayrolls.count === 1, "generate 未生成丙员工工资");
  const cPayroll = cPayrolls.results[0]!;
  recordIDs.add(cPayroll.id);
  const updatedCPayroll = await request<Payroll>(
    `/hr/payrolls/${cPayroll.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ bonus: "3", remarks: `${prefix}待发可改` }),
    },
  );
  assert(
    updatedCPayroll.status === "PENDING" &&
      updatedCPayroll.bonus === "3" &&
      updatedCPayroll.remarks === `${prefix}待发可改`,
    `pending 工资更新错误: ${JSON.stringify(updatedCPayroll)}`,
  );
  payrollChecks += 3;
  await request<Employee>(
    `/hr/employees/${employeeC.id}`,
    {
      method: "PATCH",
      headers: admin,
      body: body({ dailyWage: "77.7", monthlyAllowance: "9" }),
    },
  );
  const refreshed = await request<Payroll>(
    `/hr/payrolls/${cPayroll.id}/refresh`,
    { method: "POST", headers: admin },
  );
  assert(
    refreshed.dailyWage === "77.7" &&
      refreshed.allowance === "9" &&
      refreshed.workdays === "0.5" &&
      refreshed.attendanceDays === 1 &&
      refreshed.missingDays === 1 &&
      refreshed.overtimeHours === "1" &&
      refreshed.baseAmount === "38.85" &&
      refreshed.bonus === "3" &&
      refreshed.remarks === `${prefix}待发可改` &&
      refreshed.payable === "50.85",
    `refresh 错误: ${JSON.stringify(refreshed)}`,
  );
  payrollChecks += 11;
  const remainingResponses = await Promise.all([
    rawRequest("/hr/payroll-payments/pay-remaining", {
      method: "POST",
      headers: admin,
      body: body({ payrollId: cPayroll.id, paidOn: "2098-01-31" }),
    }),
    rawRequest("/hr/payroll-payments/pay-remaining", {
      method: "POST",
      headers: admin,
      body: body({ payrollId: cPayroll.id, paidOn: "2098-01-31" }),
    }),
  ]);
  const remainingStatuses = remainingResponses.map((response) => response.status);
  assert(
    remainingStatuses.filter((status) => status === 201).length === 1 &&
      remainingStatuses.some((status) => status === 409),
    `payRemaining 并发状态=${remainingStatuses.join(",")}`,
  );
  concurrencyChecks++;

  await request<void>(
    `/hr/attendance-corrections/${correction.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  const movedDay = await query<AttendanceDay>(
    admin,
    "/hr/attendance-days/query",
    {
      employeeId: { kind: "fk", values: [employeeB.id] },
      date: { kind: "date", op: "eq", value: "2098-01-06" },
    },
  );
  assert(movedDay.count === 0, "补卡删除未清派生日");
  correctionChecks++;

  await request<void>(
    `/hr/attendance-imports/${parsed.id}`,
    { method: "DELETE", headers: admin },
    204,
  );
  const punchesAfterDelete = await query<Row>(
    reader,
    "/hr/attendance-punches/query",
    { employeeId: { kind: "fk", values: [employeeA.id] } },
  );
  assert(punchesAfterDelete.count === 0, "批次撤销未级联打卡");
  const dayAfterDelete = await query<AttendanceDay>(
    reader,
    "/hr/attendance-days/query",
    {
      employeeId: { kind: "fk", values: [employeeA.id] },
      date: { kind: "date", op: "eq", value: "2098-01-02" },
    },
  );
  assert(dayAfterDelete.count === 0, "批次撤销未重算清日考勤");
  importChecks += 2;

  const expectedAuditActions: Array<[string, string, string[]]> = [
    ["hr_attendance_import", parsed.id, ["create", "destroy"]],
    ["hr_attendance_import", autoBatch.id, ["create", "import"]],
    ["hr_attendance_correction", correction.id, ["create", "update", "destroy"]],
    ["hr_payroll", payroll.id, ["create", "mark_paid", "mark_pending", "mark_paid"]],
    ["hr_payroll_payment", normal.id, ["create", "destroy"]],
    ["hr_employee_loan", automaticLoan.id, ["auto_repay", "auto_destroy"]],
  ];
  for (const [resource, id, actions] of expectedAuditActions) {
    const rows = await audits(resource, id);
    for (const action of actions) {
      assert(
        rows.some((row) => row.actionName === action),
        `${resource}/${id} 缺审计 action=${action}: ${JSON.stringify(rows)}`,
      );
      auditChecks++;
    }
  }
  const punchAudit = (await db`
    SELECT record_id::text AS "recordId" FROM sys_audit_log
     WHERE resource IN ('hr_attendance_punch','hr_attendance_day')
  `) as Array<{ recordId: string }>;
  const noAuditIDs = new Set([
    ...punches.results.map((item) => item.id),
    day.id,
  ]);
  assert(
    !punchAudit.some((item) => noAuditIDs.has(item.recordId)),
    "打卡/日考勤不应逐行审计",
  );
  auditChecks++;
  const paymentAuditAfter = (await db`
    SELECT count(*)::int AS count FROM sys_audit_log
     WHERE resource='hr_payroll_payment'
  `) as Array<{ count: number }>;
  assert(
    paymentAuditAfter[0]!.count === paymentAuditBefore[0]!.count +
      1,
    "失败发放产生审计或成功并发发放缺审计",
  );
  auditChecks++;

  assert(graphqlCalls === 0, `意外 GraphQL 调用=${graphqlCalls}`);
  await cleanup(admin);
  assert(cleanupCount === 0, `cleanup=${cleanupCount}`);

  console.log(
    "hr operations REST acceptance ok: " +
      `meta=${metaChecks} permissionFirst=${permissionFirst} internal=${unavailableRoutes} ` +
      `imports=${importChecks} attendance=${attendanceChecks} corrections=${correctionChecks} ` +
      `payroll=${payrollChecks} payments=${paymentChecks} loans=${loanChecks} ` +
      `audits=${auditChecks} concurrency=${concurrencyChecks} graphql=${graphqlCalls} cleanup=${cleanupCount}`,
  );
} finally {
  await cleanup(admin);
  await teardownStorage();
  await db.close();
}
