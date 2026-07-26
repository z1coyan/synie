import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const goAPIURL = process.env.GO_API_URL ?? "http://127.0.0.1:8080/api/v1";
const suffix = Date.now().toString(36).toUpperCase();
const customerCode = `E2E_C_${suffix}`;
const supplierCode = `E2E_S_${suffix}`;
const employeeCode = `E2E_E_${suffix}`;

type CreatedRecord = {
  path: "/sales/customers" | "/purchase/suppliers" | "/hr/employees";
  resource: "sal_customer" | "pur_supplier" | "hr_employee";
  id: string;
};

async function login(page: Page): Promise<string> {
  await page.goto("/login");
  const usernameInput = page.getByRole("textbox", {
    name: "用户名",
    exact: true,
  });
  const passwordInput = page.getByRole("textbox", {
    name: "密码",
    exact: true,
  });
  await expect
    .poll(() =>
      usernameInput.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await usernameInput.pressSequentially(username);
  await passwordInput.pressSequentially(password);
  await page.getByRole("button", { name: /登\s*录|正在登录/ }).click();
  await expect(
    page.getByRole("navigation", { name: "模块导航" }),
  ).toBeVisible();
  const token = await page.evaluate(() =>
    window.localStorage.getItem("synie:token"),
  );
  expect(token).toBeTruthy();
  return token!;
}

async function expectOK(
  responsePromise: Promise<import("@playwright/test").Response>,
) {
  const response = await responsePromise;
  if (response.status() === 204) {
    expect(response.ok()).toBeTruthy();
    return null;
  }
  const text = await response.text();
  expect(
    response.ok(),
    `${response.request().method()} ${response.url()}: ${response.status()} ${text}`,
  ).toBeTruthy();
  return text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
}

async function cleanupRecord(
  token: string,
  record: CreatedRecord,
): Promise<void> {
  const response = await fetch(`${goAPIURL}${record.path}/${record.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `cleanup ${record.path}/${record.id}: ${response.status} ${await response.text()}`,
    );
  }
}

function postgres(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "synie-postgres-1",
      "psql",
      "-U",
      "synie",
      "-d",
      "synie",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

function assertUUID(id: string): void {
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
}

async function createAndEditSimpleParty(args: {
  page: Page;
  route: string;
  heading: string;
  resource: "salCustomers" | "purSuppliers";
  label: "客户" | "供应商";
  apiPath: "/sales/customers" | "/purchase/suppliers";
  auditResource: "sal_customer" | "pur_supplier";
  code: string;
  name: string;
  updatedName: string;
  created: CreatedRecord[];
}): Promise<string> {
  const {
    page,
    route,
    heading,
    resource,
    label,
    apiPath,
    auditResource,
    code,
    name,
    updatedName,
    created,
  } = args;
  await page.goto(route);
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("grid", { name: `${resource} 数据表格` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新增", exact: true }).click();

  const createDrawer = page.getByRole("dialog", { name: `新增${label}` });
  await expect(createDrawer).toBeVisible();
  await createDrawer
    .getByLabel(label === "客户" ? "客户编号" : "供应商编号")
    .fill(code);
  await createDrawer
    .getByLabel(label === "客户" ? "客户名称" : "供应商名称")
    .fill(name);
  await createDrawer.getByLabel("简称").fill(`${label}简称`);
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1${apiPath}`,
  );
  await createDrawer.getByRole("button", { name: "保存", exact: true }).click();
  const createdBody = await expectOK(createResponse);
  const id = String(createdBody?.id);
  assertUUID(id);
  created.push({ path: apiPath, resource: auditResource, id });
  await expect(createDrawer).toBeHidden();

  const search = page.getByRole("searchbox", { name: "搜索" });
  await search.fill(code);
  let row = page.getByRole("row").filter({ hasText: code });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const editDrawer = page.getByRole("dialog", { name: `编辑${label}` });
  await expect(editDrawer).toBeVisible();
  await editDrawer
    .getByLabel(label === "客户" ? "客户名称" : "供应商名称")
    .fill(updatedName);
  await editDrawer.getByLabel("简称").clear();
  const updateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/v1${apiPath}/${id}`,
  );
  await editDrawer.getByRole("button", { name: "保存", exact: true }).click();
  const updated = await expectOK(updateResponse);
  expect(updated?.name).toBe(updatedName);
  expect(updated?.shortName).toBeNull();
  await expect(editDrawer).toBeHidden();
  row = page.getByRole("row").filter({ hasText: updatedName });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "确认删除" });
  await expect(confirm).toBeVisible();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/v1${apiPath}/${id}`,
  );
  await confirm.getByRole("button", { name: "确认", exact: true }).click();
  await expectOK(deleteResponse);
  await expect(row).toBeHidden();
  return id;
}

test.setTimeout(180_000);

test("客户、供应商、员工 Grid/Drawer 全程使用 Go REST", async ({ page }) => {
  const token = await login(page);
  const graphqlRequests: Array<{ url: string; body: string | null }> = [];
  const restRequests: string[] = [];
  const created: CreatedRecord[] = [];

  page.on("request", (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname;
    if (pathname === "/graphql") {
      graphqlRequests.push({
        url: outgoing.url(),
        body: outgoing.postData(),
      });
    }
    if (
      pathname.startsWith("/api/v1/sales/customers") ||
      pathname.startsWith("/api/v1/purchase/suppliers") ||
      pathname.startsWith("/api/v1/hr/employees") ||
      /\/api\/v1\/meta\/resources\/(?:salCustomers|purSuppliers|hrEmployees)$/.test(
        pathname,
      )
    ) {
      restRequests.push(`${outgoing.method()} ${pathname}`);
    }
  });

  try {
    const customerID = await createAndEditSimpleParty({
      page,
      route: "/scm/customers",
      heading: "客户管理",
      resource: "salCustomers",
      label: "客户",
      apiPath: "/sales/customers",
      auditResource: "sal_customer",
      code: customerCode,
      name: `浏览器测试客户-${suffix}`,
      updatedName: `浏览器测试客户已更新-${suffix}`,
      created,
    });

    const supplierID = await createAndEditSimpleParty({
      page,
      route: "/scm/suppliers",
      heading: "供应商管理",
      resource: "purSuppliers",
      label: "供应商",
      apiPath: "/purchase/suppliers",
      auditResource: "pur_supplier",
      code: supplierCode,
      name: `浏览器测试供应商-${suffix}`,
      updatedName: `浏览器测试供应商已更新-${suffix}`,
      created,
    });

    await page.goto("/hr/employees");
    await expect(
      page.getByRole("heading", { name: "员工档案", exact: true }),
    ).toBeVisible();
    const employeeGrid = page.getByRole("grid", {
      name: "hrEmployees 数据表格",
    });
    await expect(employeeGrid).toBeVisible();
    await page.getByRole("button", { name: "新增", exact: true }).click();

    const createEmployee = page.getByRole("dialog", { name: "新增员工" });
    await expect(createEmployee).toBeVisible();
    await createEmployee.getByLabel("员工编号").fill(employeeCode);
    await createEmployee
      .getByLabel("员工姓名")
      .fill(`浏览器测试员工-${suffix}`);
    await createEmployee.getByLabel("考勤设备编号").fill(`E2E-A-${suffix}`);
    await createEmployee.getByLabel("身份证号").fill(`E2E-ID-${suffix}`);
    await createEmployee.getByLabel("手机号码").fill("13900000000");
    await createEmployee.getByLabel("日薪").fill("300.5");
    await createEmployee.getByLabel("月补贴").fill("800");
    await createEmployee
      .getByRole("checkbox", { name: "社保工伤", exact: true })
      .check({ force: true });
    await createEmployee
      .getByRole("checkbox", { name: "公积金", exact: true })
      .check({ force: true });
    const createEmployeeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/hr/employees",
    );
    await createEmployee
      .getByRole("button", { name: "保存", exact: true })
      .click();
    const employeeBody = await expectOK(createEmployeeResponse);
    const employeeID = String(employeeBody?.id);
    assertUUID(employeeID);
    expect(Number(employeeBody?.dailyWage)).toBe(300.5);
    expect(Number(employeeBody?.monthlyAllowance)).toBe(800);
    expect(employeeBody?.insuranceTypes).toEqual([
      "SOCIAL_INJURY",
      "HOUSING_FUND",
    ]);
    created.push({
      path: "/hr/employees",
      resource: "hr_employee",
      id: employeeID,
    });
    await expect(createEmployee).toBeHidden();

    const employeeSearch = page.getByRole("searchbox", { name: "搜索" });
    await employeeSearch.fill(employeeCode);
    let employeeRow = page.getByRole("row").filter({ hasText: employeeCode });
    await expect(employeeRow).toBeVisible();
    await employeeRow.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const editEmployee = page.getByRole("dialog", { name: "编辑员工" });
    await expect(editEmployee).toBeVisible();
    await expect(editEmployee.getByLabel("日薪")).toHaveValue("300.5");
    await editEmployee.getByLabel("日薪").fill("301.25");
    await editEmployee.getByLabel("月补贴").clear();
    const housingFund = editEmployee.getByRole("checkbox", {
      name: "公积金",
      exact: true,
    });
    const commercialInjury = editEmployee.getByRole("checkbox", {
      name: "商保工伤",
      exact: true,
    });
    await expect(housingFund).toBeChecked();
    await editEmployee.getByText("公积金", { exact: true }).click();
    await expect(housingFund).not.toBeChecked();
    await expect(commercialInjury).not.toBeChecked();
    await editEmployee.getByText("商保工伤", { exact: true }).click();
    await expect(commercialInjury).toBeChecked();
    const updateEmployeeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          `/api/v1/hr/employees/${employeeID}`,
    );
    await editEmployee
      .getByRole("button", { name: "保存", exact: true })
      .click();
    const updatedEmployee = await expectOK(updateEmployeeResponse);
    expect(Number(updatedEmployee?.dailyWage)).toBe(301.25);
    expect(updatedEmployee?.monthlyAllowance).toBeNull();
    expect(updatedEmployee?.insuranceTypes).toEqual([
      "SOCIAL_INJURY",
      "COMMERCIAL_INJURY",
    ]);
    await expect(editEmployee).toBeHidden();

    await employeeGrid.getByRole("button", { name: "筛选 参保类型" }).click();
    const insuranceFilter = page.getByRole("dialog", { name: "参保类型" });
    await expect(insuranceFilter).toBeVisible();
    const filterResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/hr/employees/query" &&
        response.request().postData()?.includes('"kind":"enumArray"') === true,
    );
    await insuranceFilter
      .getByRole("checkbox", { name: "社保工伤", exact: true })
      .check({ force: true });
    await expectOK(filterResponse);
    await page.keyboard.press("Escape");
    employeeRow = page.getByRole("row").filter({ hasText: employeeCode });
    await expect(employeeRow).toBeVisible();

    await employeeRow.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "确认删除" });
    const deleteEmployeeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname ===
          `/api/v1/hr/employees/${employeeID}`,
    );
    await confirm.getByRole("button", { name: "确认", exact: true }).click();
    await expectOK(deleteEmployeeResponse);
    await expect(employeeRow).toBeHidden();

    expect(restRequests).toEqual(
      expect.arrayContaining([
        "GET /api/v1/meta/resources/salCustomers",
        "POST /api/v1/sales/customers/query",
        "POST /api/v1/sales/customers",
        `PATCH /api/v1/sales/customers/${customerID}`,
        `DELETE /api/v1/sales/customers/${customerID}`,
        "GET /api/v1/meta/resources/purSuppliers",
        "POST /api/v1/purchase/suppliers/query",
        "POST /api/v1/purchase/suppliers",
        `PATCH /api/v1/purchase/suppliers/${supplierID}`,
        `DELETE /api/v1/purchase/suppliers/${supplierID}`,
        "GET /api/v1/meta/resources/hrEmployees",
        "POST /api/v1/hr/employees/query",
        "POST /api/v1/hr/employees",
        `GET /api/v1/hr/employees/${employeeID}`,
        `PATCH /api/v1/hr/employees/${employeeID}`,
        `DELETE /api/v1/hr/employees/${employeeID}`,
      ]),
    );
    expect(graphqlRequests).toEqual([]);
  } finally {
    const cleanup = await Promise.allSettled(
      created.map((record) => cleanupRecord(token, record)),
    );
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const ids = created.map((record) => {
      assertUUID(record.id);
      return `'${record.id}'::uuid`;
    });
    if (ids.length > 0) {
      postgres(`
        DELETE FROM sys_audit_log
        WHERE record_id IN (${ids.join(",")})
          AND resource IN ('sal_customer', 'pur_supplier', 'hr_employee');
      `);
      const remaining = postgres(`
        SELECT
          (SELECT count(*) FROM sal_customers WHERE id IN (${ids.join(",")})),
          (SELECT count(*) FROM pur_supplier WHERE id IN (${ids.join(",")})),
          (SELECT count(*) FROM hr_employees WHERE id IN (${ids.join(",")})),
          (SELECT count(*) FROM sys_audit_log WHERE record_id IN (${ids.join(",")}));
      `);
      expect(remaining).toBe("0|0|0|0");
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "PR-2.10 E2E 清理失败",
      );
    }
  }
});
