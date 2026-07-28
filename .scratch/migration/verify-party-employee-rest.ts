import { SQL } from "bun";
import { join } from "node:path";

const baseURL = process.env.SYNIE_API_URL ?? process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const databaseURL =
  process.env.SYNIE_TEST_DATABASE_URL ??
  "postgres://synie:synie@127.0.0.1:5441/synie?sslmode=disable";

type APIErrorEnvelope = {
  error?: { code?: string; message?: string; fields?: unknown };
};

type ResourceMetaDocument = {
  name: string;
  grid: {
    columns: Array<Record<string, unknown>>;
    capabilities: string[];
    extendedActions: Array<Record<string, unknown>>;
    destroyMutation: string | null;
  };
  form?: Record<string, unknown>;
};

type List<T> = { count: number; results: T[] };

type Customer = {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  insertedAt: string;
  updatedAt: string;
};

type Supplier = Customer;

type Employee = {
  id: string;
  code: string;
  name: string;
  attendanceNo: string | null;
  idNumber: string | null;
  householdRegistration: string | null;
  phone: string | null;
  currentAddress: string | null;
  dailyWage: string | null;
  monthlyAllowance: string | null;
  insuranceTypes: string[];
  insertedAt: string;
  updatedAt: string;
};

type AuditRow = {
  id: string;
  actionName: string;
  changes: Record<string, { from?: unknown; to?: unknown }>;
};

const db = new SQL(databaseURL);
const suffix = crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 10)
  .toUpperCase();
const prefix = `ZZR210${suffix}`;
const trackedIDs = new Set<string>();
const customerIDs = new Set<string>();
const supplierIDs = new Set<string>();
const employeeIDs = new Set<string>();
const directFixtureIDs = new Set<string>();
let roleID: string | null = null;
let limitedUserID: string | null = null;
let numberingRuleID: string | null = null;

function body(value: unknown) {
  return JSON.stringify(value);
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function requestText(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<string> {
  const response = await fetch(baseURL + path, init);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    let detail = text;
    try {
      const envelope = JSON.parse(text) as APIErrorEnvelope;
      detail = `${envelope.error?.code ?? "unknown"}:${envelope.error?.message ?? text}`;
    } catch {
      // 非 JSON 错误保留原始响应。
    }
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status}, want ${expectedStatus}, ${detail}`,
    );
  }
  return text;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const text = await requestText(path, init, expectedStatus);
  return text === "" ? (undefined as T) : (JSON.parse(text) as T);
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
) {
  assertDeepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} keys`,
  );
}

async function snapshot(resource: string, actor: "superadmin" | "read-only") {
  return Bun.file(
    join(
      import.meta.dir,
      "snapshots",
      "pr-2.10",
      `${resource}.${actor}.grid.json`,
    ),
  ).json();
}

async function createCustomer(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const created = await request<Customer>(
    "/sales/customers",
    { method: "POST", headers, body: body(payload) },
    201,
  );
  customerIDs.add(created.id);
  trackedIDs.add(created.id);
  return created;
}

async function createSupplier(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const created = await request<Supplier>(
    "/purchase/suppliers",
    { method: "POST", headers, body: body(payload) },
    201,
  );
  supplierIDs.add(created.id);
  trackedIDs.add(created.id);
  return created;
}

async function createEmployee(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const created = await request<Employee>(
    "/hr/employees",
    { method: "POST", headers, body: body(payload) },
    201,
  );
  employeeIDs.add(created.id);
  trackedIDs.add(created.id);
  return created;
}

async function audits(resource: string, recordID: string): Promise<AuditRow[]> {
  return (await db`
    SELECT
      id::text AS id,
      action_name AS "actionName",
      changes
    FROM sys_audit_log
    WHERE resource = ${resource}
      AND record_id = ${recordID}::uuid
    ORDER BY inserted_at, id
  `) as AuditRow[];
}

async function deleteAuditRows() {
  for (const id of trackedIDs) {
    await db`DELETE FROM sys_audit_log WHERE record_id = ${id}::uuid`;
  }
}

async function assertNoFixtureRows() {
  const rows = (await db`
    SELECT
      (SELECT count(*) FROM sal_customers WHERE code LIKE ${prefix + "%"})::int AS customers,
      (SELECT count(*) FROM pur_supplier WHERE code LIKE ${prefix + "%"})::int AS suppliers,
      (SELECT count(*) FROM hr_employees WHERE code LIKE ${prefix + "%"})::int AS employees,
      (SELECT count(*) FROM inv_material WHERE code LIKE ${prefix + "%"})::int AS materials,
      (SELECT count(*) FROM inv_material_category WHERE code LIKE ${prefix + "%"})::int AS categories,
      (SELECT count(*) FROM sys_numbering_rule WHERE name LIKE ${prefix + "%"})::int AS rules,
      (SELECT count(*) FROM sys_role WHERE code LIKE ${prefix + "%"})::int AS roles,
      (SELECT count(*) FROM sys_user WHERE username::text LIKE ${prefix.toLowerCase() + "%"})::int AS users
  `) as Array<Record<string, number>>;
  const remaining = rows[0]!;
  assert(
    Object.values(remaining).every((value) => Number(value) === 0),
    `测试数据未归零: ${JSON.stringify(remaining)}`,
  );
  for (const id of trackedIDs) {
    const result = (await db`
      SELECT count(*)::int AS count
      FROM sys_audit_log
      WHERE record_id = ${id}::uuid
    `) as Array<{ count: number }>;
    assert(Number(result[0]!.count) === 0, `审计未归零: ${id}`);
  }
}

const adminLogin = await request<{
  token: string;
  user: { id: string };
}>("/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body({ username, password }),
});
const adminHeaders = authHeaders(adminLogin.token);

try {
  await assertNoFixtureRows();

  const metaResources = [
    "salCustomers",
    "purSuppliers",
    "hrEmployees",
  ] as const;
  const expectedForms: Record<string, Record<string, unknown>> = {
    salCustomers: {
      exclude: ["id", "insertedAt", "updatedAt"],
      fields: {
        code: { required: true, placeholder: "如 C0001" },
        name: { required: true, placeholder: "客户全称" },
        shortName: { placeholder: "如 华为" },
      },
    },
    purSuppliers: {
      exclude: ["id", "insertedAt", "updatedAt"],
      fields: {
        code: { required: true, placeholder: "如 S0001" },
        name: { required: true, placeholder: "供应商全称" },
        shortName: { placeholder: "如 富士康" },
      },
    },
    hrEmployees: {
      exclude: ["id", "insertedAt", "updatedAt"],
      fields: {
        code: { required: false, placeholder: "留空自动编号" },
        name: { required: true },
      },
    },
  };
  for (const resource of metaResources) {
    const meta = await request<ResourceMetaDocument>(
      `/meta/resources/${resource}`,
      { headers: adminHeaders },
    );
    assertDeepEqual(
      meta.grid,
      await snapshot(resource, "superadmin"),
      `${resource} superadmin GridMeta`,
    );
    assertDeepEqual(meta.form, expectedForms[resource], `${resource} form`);
  }

  // 通用枚举和枚举数组都按 Meta 的大写 token 入参、按数据库小写值匹配。
  const [weightUnits, exchangeInstruments] = await Promise.all([
    request<List<{ id: string }>>("/base/units/query", {
      method: "POST",
      headers: adminHeaders,
      body: body({
        limit: 200,
        offset: 0,
        filter: { unitType: { kind: "enum", values: ["WEIGHT"] } },
      }),
    }),
    request<List<{ id: string }>>("/base/market-instruments/query", {
      method: "POST",
      headers: adminHeaders,
      body: body({
        limit: 200,
        offset: 0,
        filter: { sourceType: { kind: "enum", values: ["EXCHANGE"] } },
      }),
    }),
  ]);
  assert(weightUnits.count > 0, "普通 enum 回归: WEIGHT 单位应至少一条");
  assert(
    exchangeInstruments.count > 0,
    "普通 enum 回归: EXCHANGE 行情品种应至少一条",
  );

  const customer = await createCustomer(adminHeaders, {
    code: `${prefix}C1`,
    name: `REST 客户 ${suffix}`,
    shortName: "REST 客户",
  });
  assertExactKeys(
    customer as unknown as Record<string, unknown>,
    ["id", "code", "name", "shortName", "insertedAt", "updatedAt"],
    "customer",
  );
  assert(customer.shortName === "REST 客户", "客户简称未返回");
  const updatedCustomer = await request<Customer>(
    `/sales/customers/${customer.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({
        code: `${prefix}C2`,
        name: `REST 客户已更新 ${suffix}`,
        shortName: null,
      }),
    },
  );
  assert(
    updatedCustomer.code === `${prefix}C2` &&
      updatedCustomer.shortName === null,
    "客户可改编号/可清空简称契约失败",
  );
  await request<unknown>(
    "/sales/customers",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ code: `${prefix}C2`, name: "重复客户" }),
    },
    409,
  );
  await request<unknown>(
    "/sales/customers",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ name: "缺编号客户" }),
    },
    400,
  );
  const customerQuery = await request<List<Customer>>(
    "/sales/customers/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        limit: 20,
        offset: 0,
        search: `${prefix}C2`,
        filter: {
          code: { kind: "text", op: "eq", value: `${prefix}C2` },
        },
      }),
    },
  );
  assertDeepEqual(
    customerQuery.results.map((row) => row.id),
    [customer.id],
    "客户搜索/筛选",
  );

  const supplier = await createSupplier(adminHeaders, {
    code: `${prefix}S1`,
    name: `REST 供应商 ${suffix}`,
    shortName: "REST 供应商",
  });
  assertExactKeys(
    supplier as unknown as Record<string, unknown>,
    ["id", "code", "name", "shortName", "insertedAt", "updatedAt"],
    "supplier",
  );
  const updatedSupplier = await request<Supplier>(
    `/purchase/suppliers/${supplier.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({
        code: `${prefix}S2`,
        name: `REST 供应商已更新 ${suffix}`,
        shortName: null,
      }),
    },
  );
  assert(
    updatedSupplier.code === `${prefix}S2` &&
      updatedSupplier.shortName === null,
    "供应商可改编号/可清空简称契约失败",
  );
  await request<unknown>(
    "/purchase/suppliers",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ code: `${prefix}S2`, name: "重复供应商" }),
    },
    409,
  );
  await request<unknown>(
    "/purchase/suppliers",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ code: `${prefix}S3` }),
    },
    400,
  );
  const supplierQuery = await request<List<Supplier>>(
    "/purchase/suppliers/query",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        limit: 20,
        offset: 0,
        search: `${prefix}S2`,
        filter: {
          code: { kind: "text", op: "eq", value: `${prefix}S2` },
        },
      }),
    },
  );
  assertDeepEqual(
    supplierQuery.results.map((row) => row.id),
    [supplier.id],
    "供应商搜索/筛选",
  );

  const idNumber1 = `ID-${suffix}-A`;
  const idNumber2 = `ID-${suffix}-B`;
  const employee = await createEmployee(adminHeaders, {
    code: `${prefix}E1`,
    name: `REST 员工甲 ${suffix}`,
    attendanceNo: `${prefix}A1`,
    idNumber: idNumber1,
    householdRegistration: "浙江台州",
    phone: "13800000000",
    currentAddress: "浙江台州椒江",
    dailyWage: "300.50",
    monthlyAllowance: "800",
    insuranceTypes: ["SOCIAL_INJURY", "HOUSING_FUND", "COMMERCIAL_MEDICAL"],
  });
  assertExactKeys(
    employee as unknown as Record<string, unknown>,
    [
      "id",
      "code",
      "name",
      "attendanceNo",
      "idNumber",
      "householdRegistration",
      "phone",
      "currentAddress",
      "dailyWage",
      "monthlyAllowance",
      "insuranceTypes",
      "insertedAt",
      "updatedAt",
    ],
    "employee",
  );
  assert(employee.idNumber === idNumber1, "身份证号应在业务 API 中可见");
  assertDeepEqual(
    employee.insuranceTypes,
    ["SOCIAL_INJURY", "HOUSING_FUND", "COMMERCIAL_MEDICAL"],
    "员工参保类型返回 token",
  );

  const employeeB = await createEmployee(adminHeaders, {
    code: `${prefix}E2`,
    name: `REST 员工乙 ${suffix}`,
    insuranceTypes: ["SOCIAL_PENSION"],
  });
  const employeeC = await createEmployee(adminHeaders, {
    code: `${prefix}E3`,
    name: `REST 员工丙 ${suffix}`,
    insuranceTypes: [],
  });
  await request<unknown>(
    "/hr/employees",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({ code: `${prefix}E1`, name: "重复编号" }),
    },
    409,
  );
  await request<unknown>(
    "/hr/employees",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}E4`,
        name: "重复考勤号",
        attendanceNo: `${prefix}A1`,
      }),
    },
    409,
  );
  await request<unknown>(
    "/hr/employees",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}E5`,
        name: "重复身份证",
        idNumber: idNumber1,
      }),
    },
    409,
  );
  for (const payload of [
    { code: `${prefix}E6`, name: "负日薪", dailyWage: "-0.01" },
    {
      code: `${prefix}E7`,
      name: "负月补贴",
      monthlyAllowance: "-0.01",
    },
    {
      code: `${prefix}E8`,
      name: "未知险种",
      insuranceTypes: ["UNKNOWN_INSURANCE"],
    },
    { code: `${prefix}E9` },
  ]) {
    await request<unknown>(
      "/hr/employees",
      {
        method: "POST",
        headers: adminHeaders,
        body: body(payload),
      },
      400,
    );
  }

  const updatedEmployee = await request<Employee>(
    `/hr/employees/${employee.id}`,
    {
      method: "PATCH",
      headers: adminHeaders,
      body: body({
        idNumber: idNumber2,
        dailyWage: "301.25",
        monthlyAllowance: null,
        insuranceTypes: ["SOCIAL_INJURY", "COMMERCIAL_INJURY"],
      }),
    },
  );
  assert(updatedEmployee.idNumber === idNumber2, "身份证号更新未返回");
  assert(updatedEmployee.dailyWage === "301.25", "日薪更新错误");
  assert(updatedEmployee.monthlyAllowance === null, "月补贴清空契约失败");

  const hasInjury = await request<List<Employee>>("/hr/employees/query", {
    method: "POST",
    headers: adminHeaders,
    body: body({
      limit: 200,
      offset: 0,
      filter: {
        code: { kind: "text", op: "contains", value: prefix },
        insuranceTypes: {
          kind: "enumArray",
          op: "hasAny",
          values: ["SOCIAL_INJURY"],
        },
      },
    }),
  });
  assertDeepEqual(
    hasInjury.results.map((row) => row.id),
    [employee.id],
    "insuranceTypes hasAny",
  );
  const notInjury = await request<List<Employee>>("/hr/employees/query", {
    method: "POST",
    headers: adminHeaders,
    body: body({
      limit: 200,
      offset: 0,
      filter: {
        code: { kind: "text", op: "contains", value: prefix },
        insuranceTypes: {
          kind: "enumArray",
          op: "notHas",
          values: ["SOCIAL_INJURY"],
        },
      },
    }),
  });
  assertDeepEqual(
    notInjury.results.map((row) => row.id).sort(),
    [employeeB.id, employeeC.id].sort(),
    "insuranceTypes notHas（空数组也命中）",
  );

  const employeeAuditBeforeDelete = await audits("hr_employee", employee.id);
  assert(employeeAuditBeforeDelete.length === 2, "员工创建/更新应有两条审计");
  const auditJSON = JSON.stringify(employeeAuditBeforeDelete);
  assert(
    !auditJSON.includes(idNumber1) && !auditJSON.includes(idNumber2),
    "身份证明文进入审计",
  );
  const createIDChange = employeeAuditBeforeDelete.find(
    (row) => row.actionName === "create",
  )?.changes.id_number;
  assertDeepEqual(createIDChange, { to: "[FILTERED]" }, "身份证创建审计");
  const updateIDChange = employeeAuditBeforeDelete.find(
    (row) => row.actionName === "update",
  )?.changes.id_number;
  assertDeepEqual(
    updateIDChange,
    { from: "[FILTERED]", to: "[FILTERED]" },
    "身份证更新审计",
  );

  const activeEmployeeRules = (await db`
    SELECT id::text AS id
    FROM sys_numbering_rule
    WHERE resource = 'hr.employee' AND enabled = true
  `) as Array<{ id: string }>;
  assert(
    activeEmployeeRules.length === 0,
    "验收前已存在启用的 hr.employee 编号规则；脚本拒绝覆盖现有配置",
  );

  // REST 将 missing/null/空串统一解释为“留空”。这是迁移 transport 的归一化；
  // 旧 GraphQL 的 code 是 String!，missing/null 会在 schema 层拒绝，不能声称三态等价。
  for (const [label, payload] of [
    ["missing", { name: `无规则缺失 ${suffix}` }],
    ["null", { code: null, name: `无规则 null ${suffix}` }],
    ["empty", { code: "", name: `无规则空串 ${suffix}` }],
  ] as const) {
    await request<unknown>(
      "/hr/employees",
      {
        method: "POST",
        headers: adminHeaders,
        body: body(payload),
      },
      409,
    );
    const count = (await db`
      SELECT count(*)::int AS count
      FROM hr_employees
      WHERE name = ${payload.name}
    `) as Array<{ count: number }>;
    assert(Number(count[0]!.count) === 0, `${label} 无规则失败却落库`);
  }

  const rule = await request<{ id: string }>(
    "/system/numbering/rules",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        resource: "hr.employee",
        name: `${prefix}员工编号`,
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
  trackedIDs.add(rule.id);

  const autoEmployees: Employee[] = [];
  for (const payload of [
    { name: `自动编号缺失 ${suffix}` },
    { code: null, name: `自动编号 null ${suffix}` },
    { code: "", name: `自动编号空串 ${suffix}` },
  ]) {
    autoEmployees.push(await createEmployee(adminHeaders, payload));
  }
  assertDeepEqual(
    autoEmployees.map((row) => row.code),
    [`${prefix}AUTO-001`, `${prefix}AUTO-002`, `${prefix}AUTO-003`],
    "missing/null/空串自动编号",
  );
  const counter = (await db`
    SELECT value
    FROM sys_numbering_counter
    WHERE rule_id = ${numberingRuleID}::uuid
  `) as Array<{ value: number }>;
  assert(
    counter.length === 1 && Number(counter[0]!.value) === 3,
    "自动编号计数器应精确递增三次",
  );

  const role = await request<{ id: string }>(
    "/system/roles",
    {
      method: "POST",
      headers: adminHeaders,
      body: body({
        code: `${prefix}READ`,
        name: `${prefix}只读`,
        enabled: true,
      }),
    },
    201,
  );
  roleID = role.id;
  trackedIDs.add(role.id);
  await request<unknown>(`/system/roles/${role.id}/permissions`, {
    method: "PUT",
    headers: adminHeaders,
    body: body({
      permissions: [
        "sales.customer:read",
        "purchase.supplier:read",
        "hr.employee:read",
      ],
    }),
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
        name: `${prefix}只读用户`,
        roleIds: [role.id],
        companyIds: [],
      }),
    },
    201,
  );
  limitedUserID = limited.user.id;
  trackedIDs.add(limited.user.id);
  const limitedLogin = await request<{ token: string }>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body({
      username: limited.user.username,
      password: limited.password,
    }),
  });
  const limitedHeaders = authHeaders(limitedLogin.token);

  for (const resource of metaResources) {
    const meta = await request<ResourceMetaDocument>(
      `/meta/resources/${resource}`,
      { headers: limitedHeaders },
    );
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
  const limitedQueries = await Promise.all([
    request<List<Customer>>("/sales/customers/query", {
      method: "POST",
      headers: limitedHeaders,
      body: body({ limit: 20, offset: 0, search: prefix }),
    }),
    request<List<Supplier>>("/purchase/suppliers/query", {
      method: "POST",
      headers: limitedHeaders,
      body: body({ limit: 20, offset: 0, search: prefix }),
    }),
    request<List<Employee>>("/hr/employees/query", {
      method: "POST",
      headers: limitedHeaders,
      body: body({ limit: 200, offset: 0, search: prefix }),
    }),
  ]);
  assert(limitedQueries[0].count === 1, "只读客户查询失败");
  assert(limitedQueries[1].count === 1, "只读供应商查询失败");
  assert(limitedQueries[2].count >= 6, "只读员工查询失败");

  for (const [path, id] of [
    ["/sales/customers", customer.id],
    ["/purchase/suppliers", supplier.id],
    ["/hr/employees", employee.id],
  ] as const) {
    // 畸形 JSON 仍必须先因权限返回 403，而不是进入解码后返回 400。
    await requestText(
      path,
      {
        method: "POST",
        headers: limitedHeaders,
        body: "{",
      },
      403,
    );
    await requestText(
      `${path}/${id}`,
      {
        method: "PATCH",
        headers: limitedHeaders,
        body: "{",
      },
      403,
    );
    await requestText(
      `${path}/${id}`,
      { method: "DELETE", headers: limitedHeaders },
      403,
    );
  }

  const category = (await db`
    INSERT INTO inv_material_category (code, name)
    VALUES (${`${prefix}CAT`}, ${`${prefix}引用测试分类`})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const categoryID = category[0]!.id;
  directFixtureIDs.add(categoryID);
  const unit = (await db`
    INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio)
    VALUES ('quantity', false, ${`${prefix}测试单位`}, ${`${prefix}u`}, 1)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const unitID = unit[0]!.id;
  directFixtureIDs.add(unitID);
  const material = (await db`
    INSERT INTO inv_material (
      code, name, category_id, default_unit_id,
      is_customer_material, customer_id
    )
    VALUES (
      ${`${prefix}MAT`}, ${`${prefix}客户物料`},
      ${categoryID}::uuid, ${unitID}::uuid, true, ${customer.id}::uuid
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const materialID = material[0]!.id;
  directFixtureIDs.add(materialID);
  await request<unknown>(
    `/sales/customers/${customer.id}`,
    { method: "DELETE", headers: adminHeaders },
    409,
  );
  await db`DELETE FROM inv_material WHERE id = ${materialID}::uuid`;
  directFixtureIDs.delete(materialID);

  const attendanceDay = (await db`
    INSERT INTO hr_attendance_day (
      date, normal_hours, overtime_hours, bonus_workday, status, employee_id
    )
    VALUES ('2099-12-31', 0, 0, 0, 'normal', ${employee.id}::uuid)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const attendanceDayID = attendanceDay[0]!.id;
  directFixtureIDs.add(attendanceDayID);
  await request<unknown>(
    `/hr/employees/${employee.id}`,
    { method: "DELETE", headers: adminHeaders },
    409,
  );
  await db`DELETE FROM hr_attendance_day WHERE id = ${attendanceDayID}::uuid`;
  directFixtureIDs.delete(attendanceDayID);

  await request<void>(
    `/sales/customers/${customer.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  customerIDs.delete(customer.id);
  await request<void>(
    `/purchase/suppliers/${supplier.id}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  supplierIDs.delete(supplier.id);
  for (const id of employeeIDs) {
    await request<void>(
      `/hr/employees/${id}`,
      { method: "DELETE", headers: adminHeaders },
      204,
    );
  }
  employeeIDs.clear();

  const employeeAuditAfterDelete = await audits("hr_employee", employee.id);
  const destroyIDChange = employeeAuditAfterDelete.find(
    (row) => row.actionName === "destroy",
  )?.changes.id_number;
  assertDeepEqual(destroyIDChange, { from: "[FILTERED]" }, "身份证删除审计");
  assert(
    !JSON.stringify(employeeAuditAfterDelete).includes(idNumber2),
    "身份证更新值进入删除审计",
  );

  for (const [resource, id, expectedCount] of [
    ["sal_customer", customer.id, 3],
    ["pur_supplier", supplier.id, 3],
    ["hr_employee", employee.id, 3],
  ] as const) {
    const rows = await audits(resource, id);
    assert(
      rows.length === expectedCount,
      `${resource} 审计条数=${rows.length}, want ${expectedCount}`,
    );
  }

  await request<void>(
    `/system/users/${limitedUserID}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  limitedUserID = null;
  await request<unknown>(`/system/roles/${roleID}/permissions`, {
    method: "PUT",
    headers: adminHeaders,
    body: body({ permissions: [] }),
  });
  await request<void>(
    `/system/roles/${roleID}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  roleID = null;
  await request<void>(
    `/system/numbering/rules/${numberingRuleID}`,
    { method: "DELETE", headers: adminHeaders },
    204,
  );
  numberingRuleID = null;

  await db`DELETE FROM bas_unit WHERE id = ${unitID}::uuid`;
  directFixtureIDs.delete(unitID);
  await db`
    DELETE FROM inv_material_category WHERE id = ${categoryID}::uuid
  `;
  directFixtureIDs.delete(categoryID);
  await deleteAuditRows();
  await assertNoFixtureRows();

  console.log(
    "party/employee REST acceptance ok: meta=6 customer=1 supplier=1 " +
      "employees=6 enumArray=2 autoNumber=3 permissionFirst=9 audits=9 cleanup=0",
  );
} finally {
  for (const id of directFixtureIDs) {
    await db`DELETE FROM hr_attendance_day WHERE id = ${id}::uuid`;
    await db`DELETE FROM inv_material WHERE id = ${id}::uuid`;
  }
  for (const id of customerIDs) {
    await db`DELETE FROM inv_material WHERE customer_id = ${id}::uuid`;
  }
  for (const id of employeeIDs) {
    await db`DELETE FROM hr_attendance_day WHERE employee_id = ${id}::uuid`;
  }
  for (const id of employeeIDs) {
    await db`DELETE FROM hr_employees WHERE id = ${id}::uuid`;
  }
  for (const id of supplierIDs) {
    await db`DELETE FROM pur_supplier WHERE id = ${id}::uuid`;
  }
  for (const id of customerIDs) {
    await db`DELETE FROM sal_customers WHERE id = ${id}::uuid`;
  }
  if (limitedUserID) {
    await db`DELETE FROM sys_user_role WHERE user_id = ${limitedUserID}::uuid`;
    await db`DELETE FROM sys_user_company WHERE user_id = ${limitedUserID}::uuid`;
    await db`DELETE FROM sys_user WHERE id = ${limitedUserID}::uuid`;
  }
  if (roleID) {
    await db`DELETE FROM sys_role_permission WHERE role_id = ${roleID}::uuid`;
    await db`DELETE FROM sys_role WHERE id = ${roleID}::uuid`;
  }
  if (numberingRuleID) {
    await db`
      DELETE FROM sys_numbering_rule WHERE id = ${numberingRuleID}::uuid
    `;
  }
  for (const id of directFixtureIDs) {
    await db`DELETE FROM bas_unit WHERE id = ${id}::uuid`;
    await db`DELETE FROM inv_material_category WHERE id = ${id}::uuid`;
  }
  await deleteAuditRows();
  await assertNoFixtureRows();
  await db.close();
}
