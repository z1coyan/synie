import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EHR${suffix}`;
const fileSha256 = createHash("sha256").update(prefix).digest("hex");
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const day = `${month}-15`;

type Fixture = {
  employeeId: string;
  fileId: string;
  importId: string;
  punchId: string;
  dayId: string;
  correctionId: string;
  payrollId: string;
  paymentId: string;
  loanId: string;
  attendanceNo: string;
};

function postgres(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      pgContainer,
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

function createFixture(): Fixture {
  // 浏览器验收只需稳定的既有业务事实；这里的直写严格局限 prefix 行，
  // 不绕过被验收的页面读取/REST 边界，并在 finally 按 FK 逆序强清理。
  const raw = postgres(`
    WITH employee AS (
      INSERT INTO hr_employees(
        code,name,attendance_no,daily_wage,monthly_allowance
      ) VALUES (
        '${prefix}E1','${prefix}验收员工','${prefix}NO',100.10,10
      ) RETURNING id
    ),
    file_row AS (
      INSERT INTO sys_file(storage,key,filename,content_type,size,sha256)
      VALUES (
        'local','${prefix}/attendance.dat','${prefix}-attendance.dat',
        'text/plain',42,'${fileSha256}'
      ) RETURNING id
    ),
    import_row AS (
      INSERT INTO hr_attendance_import(
        status,error,total_rows,bad_rows,dup_rows,matched_rows,unmatched_rows,
        file_id,inserted_at,updated_at
      )
      SELECT
        'failed','${prefix}解析失败示例',3,1,0,2,0,file_row.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM file_row RETURNING id
    ),
    punch AS (
      INSERT INTO hr_attendance_punch(
        attendance_no,punched_at,employee_id,import_id,inserted_at
      )
      SELECT
        '${prefix}NO','${day} 00:01:00'::timestamp,employee.id,import_row.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM employee,import_row RETURNING id
    ),
    attendance_day AS (
      INSERT INTO hr_attendance_day(
        date,morning_in,morning_out,afternoon_in,afternoon_out,
        normal_hours,overtime_hours,bonus_workday,status,employee_id,
        inserted_at,updated_at
      )
      SELECT
        '${day}',time '08:01:00',time '11:59:00',time '13:00:00',
        time '20:31:00',7.5,3.5,0.5,'ok',employee.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM employee RETURNING id
    ),
    correction AS (
      INSERT INTO hr_attendance_correction(
        date,times,note,employee_id,inserted_at,updated_at
      )
      SELECT
        '${month}-16',ARRAY[time '08:00:00',time '17:00:00'],
        '${prefix}补卡说明',employee.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM employee RETURNING id
    ),
    payroll AS (
      INSERT INTO hr_payroll(
        month,workdays,attendance_days,missing_days,overtime_hours,daily_wage,
        base_amount,allowance,bonus,fine,loan_deduction,payable,status,remarks,
        employee_id,inserted_at,updated_at
      )
      SELECT
        '${month}',1.4375,1,0,3.5,100.10,143.89,10,5,3,2,153.89,'paid',
        '${prefix}工资备注',employee.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM employee RETURNING id,employee_id
    ),
    payment AS (
      INSERT INTO hr_payroll_payment(
        month,paid_on,amount,kind,remarks,payroll_id,employee_id,
        inserted_at,updated_at
      )
      SELECT
        '${month}','${month}-28',153.89,'normal','${prefix}发放备注',
        payroll.id,payroll.employee_id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM payroll RETURNING id
    ),
    loan AS (
      INSERT INTO hr_employee_loan(
        kind,occurred_on,amount,remarks,employee_id,inserted_at,updated_at
      )
      SELECT
        'borrow','${month}-10',100,'${prefix}借款备注',employee.id,
        (now() AT TIME ZONE 'utc') + interval '10 minutes',
        (now() AT TIME ZONE 'utc') + interval '10 minutes'
      FROM employee RETURNING id
    )
    SELECT
      employee.id::text,file_row.id::text,import_row.id::text,punch.id::text,
      attendance_day.id::text,correction.id::text,payroll.id::text,
      payment.id::text,loan.id::text
    FROM employee,file_row,import_row,punch,attendance_day,correction,payroll,
         payment,loan;
  `);
  const [
    employeeId,
    fileId,
    importId,
    punchId,
    dayId,
    correctionId,
    payrollId,
    paymentId,
    loanId,
  ] = raw.split("|");
  expect(
    employeeId &&
      fileId &&
      importId &&
      punchId &&
      dayId &&
      correctionId &&
      payrollId &&
      paymentId &&
      loanId,
    "HR 浏览器夹具创建失败",
  ).toBeTruthy();
  return {
    employeeId: employeeId!,
    fileId: fileId!,
    importId: importId!,
    punchId: punchId!,
    dayId: dayId!,
    correctionId: correctionId!,
    payrollId: payrollId!,
    paymentId: paymentId!,
    loanId: loanId!,
    attendanceNo: `${prefix}NO`,
  };
}

function cleanup(): void {
  postgres(`
    DELETE FROM sys_audit_log WHERE record_label LIKE '${prefix}%';
    DELETE FROM hr_payroll_payment WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_employee_loan WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_payroll WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_attendance_correction WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_attendance_day WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_attendance_punch WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE code LIKE '${prefix}%'
    );
    DELETE FROM hr_attendance_import WHERE file_id IN (
      SELECT id FROM sys_file WHERE filename LIKE '${prefix}%'
    );
    DELETE FROM hr_employees WHERE code LIKE '${prefix}%';
    DELETE FROM sys_file WHERE filename LIKE '${prefix}%';
  `);
  const remaining = postgres(`
    SELECT
      (SELECT count(*) FROM hr_employees WHERE code LIKE '${prefix}%') +
      (SELECT count(*) FROM sys_file WHERE filename LIKE '${prefix}%') +
      (SELECT count(*) FROM hr_payroll_payment WHERE remarks LIKE '${prefix}%') +
      (SELECT count(*) FROM hr_employee_loan WHERE remarks LIKE '${prefix}%');
  `);
  expect(Number(remaining), "HR E2E fixture 必须 cleanup=0").toBe(0);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  const user = page.getByRole("textbox", { name: "用户名", exact: true });
  const pass = page.getByRole("textbox", { name: "密码", exact: true });
  await expect
    .poll(() =>
      user.evaluate((node) =>
        Object.keys(node).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await user.pressSequentially(username);
  await pass.pressSequentially(password);
  await page.getByRole("button", { name: /登\s*录|正在登录/ }).click();
  await expect(
    page.getByRole("navigation", { name: "模块导航" }),
  ).toBeVisible();
}

async function openGridDrawer(
  page: Page,
  route: string,
  resource: string,
  rowText: string,
  drawerName: string,
  expectedText: string,
  pageErrors: string[],
) {
  await page.goto(route);
  const grid = page.getByRole("grid", { name: `${resource} 数据表格` });
  await expect(
    grid,
    `页面运行时错误: ${pageErrors.join(" | ")}`,
  ).toBeVisible();
  const row = grid.getByRole("row").filter({ hasText: rowText }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "查看", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: drawerName });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(expectedText, { exact: false })).toBeVisible();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
}

test.setTimeout(180_000);

test("考勤五页与薪资三页以 Go REST 展示关键业务事实", async ({ page }) => {
  let fixture: Fixture | null = null;
  const graphql: string[] = [];
  const hrREST: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/graphql") {
      graphql.push(`${request.method()} ${path} ${request.postData() ?? ""}`);
    }
    if (
      path.startsWith("/api/v1/hr/attendance-") ||
      path.startsWith("/api/v1/hr/payroll") ||
      path.startsWith("/api/v1/hr/employee-loans") ||
      path.startsWith("/api/v1/meta/resources/hr")
    ) {
      hrREST.push(`${request.method()} ${path}`);
    }
  });

  try {
    cleanup();
    fixture = createFixture();
    await login(page);

    await openGridDrawer(
      page,
      "/hr/attendance/punches",
      "hrAttendancePunches",
      fixture.attendanceNo,
      "打卡记录详情",
      fixture.attendanceNo,
      pageErrors,
    );
    await openGridDrawer(
      page,
      "/hr/attendance/imports",
      "hrAttendanceImports",
      prefix,
      "考勤导入详情",
      `${prefix}解析失败示例`,
      pageErrors,
    );
    await openGridDrawer(
      page,
      "/hr/attendance/days",
      "hrAttendanceDays",
      `${prefix}验收员工`,
      "日考勤详情",
      "20:31",
      pageErrors,
    );
    await page.getByRole("button", { name: "按区间重算" }).click();
    await expect(
      page.getByRole("alertdialog", { name: "按区间重算" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();

    await openGridDrawer(
      page,
      "/hr/attendance/corrections",
      "hrAttendanceCorrections",
      `${prefix}验收员工`,
      "补卡单详情",
      "08:00、17:00",
      pageErrors,
    );

    await page.goto("/hr/attendance/monthly");
    const monthly = page.getByRole("grid", {
      name: `${month} 月度考勤汇总`,
    });
    await expect(monthly).toBeVisible();
    const monthlyRow = monthly.getByRole("row").filter({
      hasText: `${prefix}验收员工`,
    });
    await expect(monthlyRow).toContainText("1.4375");
    await expect(monthlyRow).toContainText("3.5");

    await openGridDrawer(
      page,
      "/hr/payroll/slips",
      "hrPayrolls",
      `${prefix}验收员工`,
      "工资单详情",
      `${prefix}工资备注`,
      pageErrors,
    );
    await page.goto("/hr/payroll/slips");
    const payrollRow = page
      .getByRole("grid", { name: "hrPayrolls 数据表格" })
      .getByRole("row")
      .filter({ hasText: `${prefix}验收员工` });
    await payrollRow.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "查看", exact: true }).click();
    const payrollDrawer = page.getByRole("dialog", { name: "工资单详情" });
    await expect(
      payrollDrawer.getByRole("grid", { name: "发放记录" }),
    ).toContainText(`${prefix}发放备注`);
    await payrollDrawer
      .getByRole("button", { name: "关闭", exact: true })
      .click();

    await openGridDrawer(
      page,
      "/hr/payroll/payments",
      "hrPayrollPayments",
      `${prefix}验收员工`,
      "发放记录详情",
      `${prefix}发放备注`,
      pageErrors,
    );

    await page.goto("/hr/payroll/loans");
    const balances = page.getByRole("grid", { name: "员工借款余额" });
    await expect(balances).toContainText(`${prefix}验收员工`);
    await expect(balances).toContainText("100.00");
    await openGridDrawer(
      page,
      "/hr/payroll/loans",
      "hrEmployeeLoans",
      `${prefix}验收员工`,
      "员工借款详情",
      `${prefix}借款备注`,
      pageErrors,
    );

    const requiredPaths = [
      "/api/v1/hr/attendance-punches/query",
      "/api/v1/hr/attendance-imports/query",
      "/api/v1/hr/attendance-days/query",
      "/api/v1/hr/attendance-days/month-summary",
      "/api/v1/hr/attendance-corrections/query",
      "/api/v1/hr/payrolls/query",
      "/api/v1/hr/payroll-payments/query",
      "/api/v1/hr/employee-loans/query",
      "/api/v1/hr/employee-loans/balances",
    ];
    for (const path of requiredPaths) {
      expect(
        hrREST.some((request) => request.endsWith(path)),
        `缺少 REST 请求 ${path}\n${hrREST.join("\n")}`,
      ).toBeTruthy();
    }
    expect(graphql, `HR 页面意外访问 GraphQL:\n${graphql.join("\n")}`).toEqual([]);
    expect(pageErrors, `HR 页面异常:\n${pageErrors.join("\n")}`).toEqual([]);
  } finally {
    if (fixture) cleanup();
  }
});
