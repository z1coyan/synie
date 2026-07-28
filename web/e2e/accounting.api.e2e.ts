import { execFileSync } from "node:child_process";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EGL${suffix}`;
const postingDate = "2026-07-26";
const asOf = "2026-07-31";

type Fixture = {
  currencyId: string;
  companyId: string;
  companyName: string;
  otherCompanyId: string;
  receivableAccountId: string;
  offsetAccountId: string;
};

type Created = {
  customerId: string | null;
  journalId: string | null;
  lineIds: string[];
  entryIds: string[];
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
  const raw = postgres(`
    WITH currency AS (
      INSERT INTO bas_currency(name,iso_code,symbol,active)
      VALUES ('${prefix}验收币种','${prefix}CUR','¤',true)
      RETURNING id
    ),
    company_a AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}A','${prefix}验收公司A','${prefix}A',id
      FROM currency
      RETURNING id,name
    ),
    company_b AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}B','${prefix}验收公司B','${prefix}B',id
      FROM currency
      RETURNING id
    ),
    receivable AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT
        '${prefix}1122','${prefix}应收账款','debit',false,true,
        company_a.id,currency.id,'receivable'
      FROM company_a,currency
      RETURNING id
    ),
    offset_account AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT
        '${prefix}1001','${prefix}库存现金','debit',false,true,
        company_a.id,currency.id,NULL
      FROM company_a,currency
      RETURNING id
    )
    SELECT
      currency.id::text,
      company_a.id::text,
      company_a.name,
      company_b.id::text,
      receivable.id::text,
      offset_account.id::text
    FROM currency,company_a,company_b,receivable,offset_account;
  `);
  const [
    currencyId,
    companyId,
    companyName,
    otherCompanyId,
    receivableAccountId,
    offsetAccountId,
  ] = raw.split("|");
  expect(
    currencyId &&
      companyId &&
      companyName &&
      otherCompanyId &&
      receivableAccountId &&
      offsetAccountId,
    "浏览器验收基础夹具创建失败",
  ).toBeTruthy();
  return {
    currencyId: currencyId!,
    companyId: companyId!,
    companyName: companyName!,
    otherCompanyId: otherCompanyId!,
    receivableAccountId: receivableAccountId!,
    offsetAccountId: offsetAccountId!,
  };
}

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

async function apiJSON<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch",
  path: string,
  token: string,
  data?: Record<string, unknown>,
  expected = 200,
): Promise<T> {
  const response = await request[method](path, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  expect(
    response.status(),
    `${method.toUpperCase()} ${path}: ${response.status()} ${text}`,
  ).toBe(expected);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

function uuidList(ids: string[]): string {
  return ids.length === 0
    ? "ARRAY[]::uuid[]"
    : `ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`;
}

function cleanup(created: Created): void {
  const recordIds = [
    created.customerId,
    created.journalId,
    ...created.lineIds,
    ...created.entryIds,
  ].filter((id): id is string => id !== null);
  const recordArray = uuidList(recordIds);
  const journal = created.journalId
    ? `'${created.journalId}'::uuid`
    : "NULL::uuid";
  const customer = created.customerId
    ? `'${created.customerId}'::uuid`
    : "NULL::uuid";
  postgres(`
    DELETE FROM sys_audit_log WHERE record_id=ANY(${recordArray});
    DELETE FROM acc_gl_entry
      WHERE voucher_id=${journal} OR voucher_no LIKE '${prefix}%';
    DELETE FROM acc_gl_journal_line
      WHERE journal_id=${journal} OR id=ANY(${uuidList(created.lineIds)});
    DELETE FROM acc_gl_journal
      WHERE id=${journal} OR voucher_no LIKE '${prefix}%';
    DELETE FROM sal_customers
      WHERE id=${customer} OR code LIKE '${prefix}%';
    DELETE FROM bas_account WHERE code LIKE '${prefix}%';
    DELETE FROM bas_company WHERE code LIKE '${prefix}%';
    DELETE FROM bas_currency WHERE iso_code LIKE '${prefix}%';
  `);
  const residue = postgres(`
    SELECT
      (SELECT count(*) FROM acc_gl_journal WHERE voucher_no LIKE '${prefix}%'),
      (SELECT count(*) FROM acc_gl_journal_line WHERE id=ANY(${uuidList(created.lineIds)})),
      (SELECT count(*) FROM acc_gl_entry WHERE voucher_no LIKE '${prefix}%'),
      (SELECT count(*) FROM sal_customers WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_account WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_company WHERE code LIKE '${prefix}%'),
      (SELECT count(*) FROM bas_currency WHERE iso_code LIKE '${prefix}%'),
      (SELECT count(*) FROM sys_audit_log WHERE record_id=ANY(${recordArray}));
  `);
  expect(residue, "Chromium 验收夹具与审计必须精确归零").toBe(
    "0|0|0|0|0|0|0|0",
  );
}

async function rowForVoucher(page: Page, voucherNo: string) {
  const search = page.getByRole("searchbox", { name: "搜索" });
  await search.fill(voucherNo);
  const row = page.getByRole("row").filter({ hasText: voucherNo });
  await expect(row).toBeVisible();
  return row;
}

test.setTimeout(240_000);

test("财务三页面以 Go REST 完成两行凭证审核、报表下钻与取消", async ({
  page,
  request,
}) => {
  const created: Created = {
    customerId: null,
    journalId: null,
    lineIds: [],
    entryIds: [],
  };
  const graphqlRequests: Array<{ url: string; body: string | null }> = [];
  const restRequests: string[] = [];

  page.on("request", (outgoing) => {
    const pathname = new URL(outgoing.url()).pathname;
    if (pathname === "/graphql") {
      graphqlRequests.push({
        url: outgoing.url(),
        body: outgoing.postData(),
      });
    }
    if (
      pathname.startsWith("/api/v1/accounting/") ||
      /^\/api\/v1\/meta\/resources\/accGl/.test(pathname)
    ) {
      restRequests.push(`${outgoing.method()} ${pathname}`);
    }
  });

  const voucherNo = `${prefix}-A`;
  const customerName = `${prefix}浏览器客户`;

  try {
    const f = createFixture();
    const token = await login(page);
    const customer = await apiJSON<{ id: string }>(
      request,
      "post",
      "/api/v1/sales/customers",
      token,
      {
        code: `${prefix}C`,
        name: customerName,
        shortName: "Chromium PR-2.12",
      },
      201,
    );
    created.customerId = customer.id;

    // REST 建立草稿头和两行；浏览器页面执行状态动作并验证只读消费面。
    const journal = await apiJSON<{ id: string; status: string }>(
      request,
      "post",
      "/api/v1/accounting/gl-journals",
      token,
      {
        voucherNo,
        date: postingDate,
        postingDate,
        companyId: f.companyId,
        remarks: `${prefix} UI/REST`,
      },
      201,
    );
    created.journalId = journal.id;
    expect(journal.status).toBe("DRAFT");

    for (const input of [
      {
        journalId: journal.id,
        idx: 1,
        accountId: f.receivableAccountId,
        debit: "125.50",
        credit: "0",
        partyType: "CUSTOMER",
        partyId: customer.id,
        remarks: `${prefix}应收`,
      },
      {
        journalId: journal.id,
        idx: 2,
        accountId: f.offsetAccountId,
        debit: "0",
        credit: "125.50",
        remarks: `${prefix}对方`,
      },
    ]) {
      const line = await apiJSON<{ id: string; journalId: string }>(
        request,
        "post",
        "/api/v1/accounting/gl-journal-lines",
        token,
        input,
        201,
      );
      expect(line.journalId).toBe(journal.id);
      created.lineIds.push(line.id);
    }
    const lineList = await apiJSON<{
      count: number;
      results: Array<{ id: string; idx: number }>;
    }>(request, "post", "/api/v1/accounting/gl-journal-lines/query", token, {
      limit: 20,
      offset: 0,
      sort: { column: "idx", direction: "ascending" },
      filter: {
        journalId: {
          kind: "fk",
          op: "in",
          values: [journal.id],
          labels: [],
        },
      },
    });
    expect(lineList.count).toBe(2);
    expect(lineList.results.map((line) => line.idx)).toEqual([1, 2]);

    await page.goto("/finance/journals");
    await expect(
      page.getByRole("heading", { name: "会计凭证", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "accGlJournals 数据表格" }),
    ).toBeVisible();
    let row = await rowForVoucher(page, voucherNo);
    await expect(row).toContainText("草稿");
    await row.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "审核", exact: true }).click();
    const auditDialog = page.getByRole("alertdialog", {
      name: "审核过账",
    });
    await expect(auditDialog).toBeVisible();
    const auditResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/accounting/gl-journals/${journal.id}/audit`,
    );
    await auditDialog
      .getByRole("button", { name: "审核过账", exact: true })
      .click();
    expect((await auditResponse).ok()).toBeTruthy();
    await expect(page.getByText("凭证已审核过账")).toBeVisible();

    const entries = await apiJSON<{
      count: number;
      results: Array<{
        id: string;
        voucherId: string;
        isCancelled: boolean;
      }>;
    }>(request, "post", "/api/v1/accounting/gl-entries/query", token, {
      limit: 20,
      offset: 0,
      filter: {
        voucherNo: { kind: "text", op: "eq", value: voucherNo },
      },
    });
    expect(entries.count).toBe(2);
    expect(
      entries.results.every(
        (entry) => entry.voucherId === journal.id && !entry.isCancelled,
      ),
    ).toBe(true);
    created.entryIds.push(...entries.results.map((entry) => entry.id));

    await page.goto("/finance/entries");
    await expect(
      page.getByRole("heading", { name: "总账分录", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("grid", { name: "accGlEntries 数据表格" }),
    ).toBeVisible();
    const entrySearch = page.getByRole("searchbox", { name: "搜索" });
    await entrySearch.fill(voucherNo);
    await expect(
      page.getByRole("row").filter({ hasText: voucherNo }),
    ).toHaveCount(2);

    await page.goto("/finance/ar-ap");
    await expect(
      page.getByRole("heading", { name: "应收应付", exact: true }),
    ).toBeVisible();
    // HeroUI Autocomplete 的 aria-label 在隐藏触发 button 上；可见点击面是相邻 group。
    const companySelect = page
      .getByRole("group")
      .filter({ hasText: "选择公司" });
    await companySelect.click();
    await page.getByRole("option").filter({ hasText: f.companyName }).click();
    await expect
      .poll(() =>
        restRequests.some(
          (entry) => entry === "GET /api/v1/accounting/ar-ap-report",
        ),
      )
      .toBe(true);
    const reportRow = page.getByRole("row").filter({ hasText: customerName });
    await expect(reportRow).toBeVisible();
    await expect(reportRow).toContainText("125.50");
    await reportRow.getByRole("link").last().click();
    await expect(page).toHaveURL(/\/finance\/entries/);
    await expect(
      page.getByRole("row").filter({ hasText: voucherNo }),
    ).toBeVisible();

    await page.goto("/finance/journals");
    await expect(
      page.getByRole("grid", { name: "accGlJournals 数据表格" }),
    ).toBeVisible();
    row = await rowForVoucher(page, voucherNo);
    await expect(row).toContainText("已审核");
    await row.getByRole("button", { name: "行操作" }).click();
    await page.getByRole("menuitem", { name: "取消", exact: true }).click();
    const cancelDialog = page.getByRole("alertdialog", {
      name: "确认取消",
    });
    await expect(cancelDialog).toBeVisible();
    const cancelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/accounting/gl-journals/${journal.id}/cancel`,
    );
    await cancelDialog
      .getByRole("button", { name: "确认", exact: true })
      .click();
    expect((await cancelResponse).ok()).toBeTruthy();
    await expect(page.getByText("取消成功(1 条)")).toBeVisible();

    const reportAfterCancel = await apiJSON<{
      rows: Array<{ partyId: string | null }>;
    }>(
      request,
      "get",
      `/api/v1/accounting/ar-ap-report?companyId=${f.companyId}&asOf=${asOf}`,
      token,
    );
    expect(
      reportAfterCancel.rows.some(
        (reportRow) => reportRow.partyId === customer.id,
      ),
    ).toBe(false);

    expect(
      restRequests,
      `实际 accounting REST 请求:\n${restRequests.join("\n")}`,
    ).toEqual(
      expect.arrayContaining([
        "GET /api/v1/meta/resources/accGlJournals",
        "POST /api/v1/accounting/gl-journals/query",
        `POST /api/v1/accounting/gl-journals/${journal.id}/audit`,
        "GET /api/v1/meta/resources/accGlEntries",
        "POST /api/v1/accounting/gl-entries/query",
        "GET /api/v1/accounting/ar-ap-report",
        `POST /api/v1/accounting/gl-journals/${journal.id}/cancel`,
      ]),
    );
    expect(graphqlRequests, "财务目标会话 /graphql 必须为 0").toEqual([]);
  } finally {
    cleanup(created);
  }
});
