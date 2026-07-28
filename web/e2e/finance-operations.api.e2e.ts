import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
const password =
  process.env.E2E_ADMIN_PASSWORD ?? "synie-integration-admin-password";
const pgContainer = process.env.SYNIE_PG_CONTAINER ?? "synie-postgres-1";
const pgDb = process.env.SYNIE_PG_DB ?? "synie";
const suffix = Date.now().toString(36).toUpperCase();
const prefix = `E2EFIN${suffix}`;

type Fixture = {
  currencyID: string;
  companyID: string;
  employeeID: string;
  bankAccountID: string;
  bankTransactionID: string;
  templateID: string;
  fileID: string;
  importID: string;
  importItemID: string;
  journalID: string;
  reconciliationID: string;
  invoiceID: string;
  reportID: string;
  reportItemID: string;
  billID: string;
  billTransactionID: string;
  holdingID: string;
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
      pgDb,
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
      VALUES ('${prefix}验收币','Q${suffix}','¤',true)
      RETURNING id
    ),
    company AS (
      INSERT INTO bas_company(code,name,short_name,base_currency_id)
      SELECT '${prefix}CO','${prefix}验收公司','${prefix}公司',id
      FROM currency
      RETURNING id
    ),
    employee AS (
      INSERT INTO hr_employees(code,name)
      VALUES ('${prefix}E1','${prefix}验收员工')
      RETURNING id
    ),
    bank_ledger AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id
      )
      SELECT '${prefix}1002','${prefix}银行存款','debit',false,true,
             company.id,currency.id
      FROM company,currency
      RETURNING id
    ),
    expense_account AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT '${prefix}6601','${prefix}费用科目','debit',false,true,
             company.id,currency.id,'management_expense'
      FROM company,currency
      RETURNING id
    ),
    payable_account AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id,role
      )
      SELECT '${prefix}2241','${prefix}其他应付款','credit',false,true,
             company.id,currency.id,'other_payable'
      FROM company,currency
      RETURNING id
    ),
    bill_account AS (
      INSERT INTO bas_account(
        code,name,direction,is_group,active,company_id,currency_id
      )
      SELECT '${prefix}1121','${prefix}应收票据','debit',false,true,
             company.id,currency.id
      FROM company,currency
      RETURNING id
    ),
    bank_account AS (
      INSERT INTO acc_bank_account(
        alias,bank_name,branch_name,holder_name,account_no,active,note,
        company_id,currency_id,account_id
      )
      SELECT
        '${prefix}基本户','${prefix}银行',NULL,'${prefix}验收公司',
        '${prefix}001',true,'${prefix}账户备注',company.id,currency.id,
        bank_ledger.id
      FROM company,currency,bank_ledger
      RETURNING id,company_id
    ),
    bank_transaction AS (
      INSERT INTO acc_bank_transaction(
        occurred_at,income,expense,balance,counterparty_name,summary,note,
        reconciled_amount,unreconciled_amount,reconcile_status,
        company_id,bank_account_id
      )
      SELECT
        '2098-07-26 02:30:00',100,NULL,NULL,'${prefix}对手',
        '${prefix}收入流水',NULL,25,75,'partial',company_id,id
      FROM bank_account
      RETURNING id,company_id,bank_account_id
    ),
    template AS (
      INSERT INTO acc_bank_import_template(
        name,start_row,datetime_col,datetime_format,amount_col,balance_col,
        summary_col,company_id,bank_account_id
      )
      SELECT
        '${prefix}导入模板',2,'A','ymd_dash_hms','B','C','D',
        company_id,id
      FROM bank_account
      RETURNING id,company_id,bank_account_id
    ),
    file_row AS (
      INSERT INTO sys_file(storage,key,filename,content_type,size,sha256)
      VALUES(
        'local','${prefix}/bank.xlsx','${prefix}-bank.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        8,'${suffix}${suffix}${suffix}${suffix}'
      )
      RETURNING id
    ),
    import_row AS (
      INSERT INTO acc_bank_import(
        status,error,company_id,bank_account_id,template_id,file_id
      )
      SELECT
        'failed','${prefix}可读解析失败',template.company_id,
        template.bank_account_id,template.id,file_row.id
      FROM template,file_row
      RETURNING id,company_id
    ),
    import_item AS (
      INSERT INTO acc_bank_import_item(
        row_no,occurred_at,income,summary,error,import_id,company_id
      )
      SELECT
        2,'2098-07-26 02:30:00',100,'${prefix}导入暂存行',
        '${prefix}行错误',import_row.id,import_row.company_id
      FROM import_row
      RETURNING id
    ),
    journal AS (
      INSERT INTO acc_gl_journal(
        voucher_no,date,posting_date,remarks,status,company_id
      )
      SELECT
        '${prefix}J1','2098-07-26','2098-07-26',
        '${prefix}已审核凭证','audited',company.id
      FROM company
      RETURNING id,company_id
    ),
    reconciliation AS (
      INSERT INTO acc_bank_reconciliation(
        amount,company_id,bank_transaction_id,journal_id
      )
      SELECT 25,bank_transaction.company_id,bank_transaction.id,journal.id
      FROM bank_transaction,journal
      RETURNING id
    ),
    invoice AS (
      INSERT INTO acc_vat_invoice(
        doc_no,direction,invoice_date,party_type,party_id,invoice_kind,
        invoice_code,invoice_no,items,net_total,tax_total,gross_total,
        remarks,status,company_id,party_account_id,amount_account_id
      )
      SELECT
        '${prefix}INV','inbound','2098-07-26','employee',employee.id,'normal',
        '${prefix}IC','${prefix}IN',
        ARRAY['{"name":"${prefix}项目","quantity":"1","net_amount":"100"}'::jsonb],
        100,0,100,'${prefix}发票备注','draft',company.id,
        payable_account.id,expense_account.id
      FROM employee,company,payable_account,expense_account
      RETURNING id,company_id
    ),
    report AS (
      INSERT INTO acc_expense_report(
        doc_no,expense_date,remarks,status,company_id,employee_id,
        payment_account_id
      )
      SELECT
        '${prefix}EXP','2098-07-26','${prefix}报销备注','draft',
        company.id,employee.id,payable_account.id
      FROM company,employee,payable_account
      RETURNING id,company_id
    ),
    report_item AS (
      INSERT INTO acc_expense_report_item(
        idx,kind,summary,amount,remarks,report_id,company_id,expense_account_id
      )
      SELECT
        1,'manual','${prefix}手工费用',88,'${prefix}报销行',
        report.id,report.company_id,expense_account.id
      FROM report,expense_account
      RETURNING id
    ),
    bill AS (
      INSERT INTO acc_bill(
        bill_no,bill_kind,issue_date,due_date,face_amount,drawer_name,
        transferable,remarks
      )
      VALUES(
        '${prefix}BILL','bank_acceptance','2098-07-01','2098-12-31',
        10,'${prefix}出票人',true,'${prefix}票面备注'
      )
      RETURNING id
    ),
    bill_transaction AS (
      INSERT INTO acc_bill_transaction(
        doc_no,transaction_type,occurred_on,sub_start,sub_end,amount,
        party_type,party_id,posting_date,status,audited_at,remarks,company_id,
        bank_account_id,bill_id,bill_account_id,settle_account_id
      )
      SELECT
        '${prefix}BT','receive','2098-07-26',3000000001,3000001000,10,
        'employee',employee.id,'2098-07-26','audited',
        (now() AT TIME ZONE 'utc'),'${prefix}承兑备注',company.id,
        bank_account.id,bill.id,bill_account.id,payable_account.id
      FROM employee,company,bank_account,bill,bill_account,payable_account
      RETURNING id,company_id,bank_account_id,bill_id
    ),
    holding AS (
      INSERT INTO acc_bill_holding(
        bill_no,sub_start,sub_end,amount,due_date,acquired_on,company_id,
        bank_account_id,bill_id,source_transaction_id
      )
      SELECT
        '${prefix}BILL',3000000001,3000001000,10,'2098-12-31','2098-07-26',
        company_id,bank_account_id,bill_id,id
      FROM bill_transaction
      RETURNING id
    )
    SELECT
      currency.id::text,company.id::text,employee.id::text,
      bank_account.id::text,bank_transaction.id::text,template.id::text,
      file_row.id::text,import_row.id::text,import_item.id::text,
      journal.id::text,reconciliation.id::text,invoice.id::text,
      report.id::text,report_item.id::text,bill.id::text,
      bill_transaction.id::text,holding.id::text
    FROM currency,company,employee,bank_account,bank_transaction,template,
         file_row,import_row,import_item,journal,reconciliation,invoice,report,
         report_item,bill,bill_transaction,holding;
  `);
  const values = raw.split("|");
  expect(values, "Finance 浏览器夹具创建失败").toHaveLength(17);
  return {
    currencyID: values[0]!,
    companyID: values[1]!,
    employeeID: values[2]!,
    bankAccountID: values[3]!,
    bankTransactionID: values[4]!,
    templateID: values[5]!,
    fileID: values[6]!,
    importID: values[7]!,
    importItemID: values[8]!,
    journalID: values[9]!,
    reconciliationID: values[10]!,
    invoiceID: values[11]!,
    reportID: values[12]!,
    reportItemID: values[13]!,
    billID: values[14]!,
    billTransactionID: values[15]!,
    holdingID: values[16]!,
  };
}

function cleanup(fixture: Fixture | null): void {
  if (!fixture) return;
  postgres(`
    DELETE FROM sys_audit_log WHERE company_id='${fixture.companyID}'::uuid
      OR record_label LIKE '${prefix}%';
    DELETE FROM acc_gl_entry WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_reconciliation WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_gl_journal_line WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_gl_journal WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bill_holding WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bill_transaction WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bill WHERE bill_no LIKE '${prefix}%';
    DELETE FROM acc_expense_report_item WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_expense_report WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_vat_invoice WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_import_item WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_import WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_import_template WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_transaction WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM acc_bank_account WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM bas_account WHERE company_id='${fixture.companyID}'::uuid;
    DELETE FROM hr_employees WHERE id='${fixture.employeeID}'::uuid;
    DELETE FROM sys_file WHERE id='${fixture.fileID}'::uuid;
    DELETE FROM bas_company WHERE id='${fixture.companyID}'::uuid;
    DELETE FROM bas_currency WHERE id='${fixture.currencyID}'::uuid;
  `);
  const remaining = postgres(`
    SELECT
      (SELECT count(*) FROM bas_company WHERE code LIKE '${prefix}%') +
      (SELECT count(*) FROM acc_bank_account WHERE alias LIKE '${prefix}%') +
      (SELECT count(*) FROM acc_vat_invoice WHERE doc_no LIKE '${prefix}%') +
      (SELECT count(*) FROM acc_expense_report WHERE doc_no LIKE '${prefix}%') +
      (SELECT count(*) FROM acc_bill WHERE bill_no LIKE '${prefix}%') +
      (SELECT count(*) FROM sys_file WHERE filename LIKE '${prefix}%') +
      (SELECT count(*) FROM sys_audit_log WHERE record_label LIKE '${prefix}%');
  `);
  expect(Number(remaining), "Finance E2E fixture 必须 cleanup=0").toBe(0);
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

async function grid(page: Page, resource: string): Promise<Locator> {
  const result = page.getByRole("grid", { name: `${resource} 数据表格` });
  await expect(result).toBeVisible();
  return result;
}

async function openRow(
  page: Page,
  resource: string,
  text: string,
): Promise<void> {
  const row = (await grid(page, resource))
    .getByRole("row")
    .filter({ hasText: text })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "行操作" }).click();
  await page.getByRole("menuitem", { name: "查看", exact: true }).click();
}

async function closeDialog(page: Page, name: RegExp | string): Promise<void> {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.setTimeout(240_000);

test("Finance 九页及操作 drawer 仅以 Go REST 消费并保持零页面错误", async ({
  page,
}) => {
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  let fixture: Fixture | null = null;
  const graphql: string[] = [];
  const financeREST: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/graphql") {
      graphql.push(`${request.method()} ${path} ${request.postData() ?? ""}`);
    }
    if (
      path.startsWith("/api/v1/finance/") ||
      path.startsWith("/api/v1/meta/resources/acc")
    ) {
      financeREST.push(`${request.method()} ${path}`);
    }
  });

  try {
    await test.step("准备独立 Finance fixture 并登录", async () => {
      fixture = createFixture();
      await login(page);
    });

    // 财务菜单九页（设置页不属于 PR-2.20 业务操作面）。
    await test.step("账务三页及银行账户/模板详情", async () => {
      await page.goto("/finance/journals");
      await grid(page, "accGlJournals");
      await page.goto("/finance/entries");
      await grid(page, "accGlEntries");
      await page.goto("/finance/ar-ap");
      await expect(page.getByRole("heading", { name: "应收应付" })).toBeVisible();

      await page.goto("/finance/bank-accounts");
      await openRow(page, "accBankAccounts", `${prefix}基本户`);
      await closeDialog(page, /银行账户详情/);

      await page.goto("/finance/bank-import-templates");
      await openRow(page, "accBankImportTemplates", `${prefix}导入模板`);
      await closeDialog(page, /导入模板详情/);
    });

    await test.step("银行流水对账 drawer", async () => {
      await page.goto("/finance/bank-transactions");
      await grid(page, "accBankTransactions");
      const bankRow = page
        .getByRole("grid", { name: "accBankTransactions 数据表格" })
        .getByRole("row")
        .filter({ hasText: `${prefix}收入流水` })
        .first();
      const rowActions = bankRow.getByRole("button", { name: "行操作" });
      await expect(rowActions).toBeVisible();
      await rowActions.click();
      const reconcileAction = page.getByRole("menuitem", {
        name: "对账",
        exact: true,
      });
      await expect(reconcileAction).toBeVisible();
      await reconcileAction.click();
      const reconcile = page.getByRole("dialog", { name: /流水对账详情/ });
      await expect(reconcile).toBeVisible();
      await expect(
        reconcile.getByRole("button", { name: "快速新增凭证" }),
      ).toBeVisible();
      const closeReconcile = reconcile.getByRole("button", {
        name: "关闭",
        exact: true,
      });
      await expect(closeReconcile).toBeVisible();
      await closeReconcile.click();
      await expect(reconcile).toBeHidden();
    });

    // 导入三 drawer：新增解析、历史、批次详情/失败留痕。
    await test.step("流水导入新增、历史、失败批次三 drawer", async () => {
      const importMenuButton = page.getByRole("button", {
        name: "导入",
        exact: true,
      });
      await expect(importMenuButton).toBeVisible();
      await importMenuButton.click();
      const createImportAction = page.getByRole("menuitem", {
        name: "新增导入",
        exact: true,
      });
      await expect(createImportAction).toBeVisible();
      await createImportAction.click();
      const createImport = page.getByRole("dialog", { name: /新增流水导入/ });
      await expect(createImport).toContainText("支持 xlsx / xls");
      await createImport
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(createImport).toBeHidden();
      await importMenuButton.click();
      const historyAction = page.getByRole("menuitem", {
        name: "导入历史",
        exact: true,
      });
      await expect(historyAction).toBeVisible();
      await historyAction.click();
      const history = page.getByRole("dialog", { name: "导入历史" });
      await expect(history).toBeVisible();
      const historyRow = history
        .getByRole("grid", { name: "accBankImports 数据表格" })
        .getByRole("row")
        .filter({ hasText: prefix })
        .filter({ hasText: "解析失败" })
        .first();
      await expect(historyRow).toBeVisible();
      const historyActions = historyRow.getByRole("button", {
        name: "行操作",
      });
      await expect(historyActions).toBeVisible();
      await historyActions.click();
      const viewImport = page.getByRole("menuitem", {
        name: "查看",
        exact: true,
      });
      await expect(viewImport).toBeVisible();
      await viewImport.click();
      const batch = page.getByRole("dialog", { name: /流水导入详情/ });
      await expect(batch).toContainText(`${prefix}可读解析失败`);
      await batch.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(batch).toBeHidden();
      await history.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(history).toBeHidden();
    });

    await test.step("发票详情、新增与 OCR 入口", async () => {
      await page.goto("/finance/invoices");
      await openRow(page, "accVatInvoices", `${prefix}INV`);
      const invoice = page.getByRole("dialog", { name: /发票详情/ });
      await expect(invoice).toContainText(`${prefix}项目`);
      await invoice.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(invoice).toBeHidden();
      const createInvoiceButton = page.getByRole("button", {
        name: "新增",
        exact: true,
      });
      await expect(createInvoiceButton).toBeVisible();
      await createInvoiceButton.click();
      const createInvoice = page.getByRole("dialog", { name: /新增发票/ });
      await expect(createInvoice).toContainText("费用报销");
      await expect(createInvoice).toContainText("OCR");
      await createInvoice
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(createInvoice).toBeHidden();
    });

    await test.step("报销单详情、明细子表与新增入口", async () => {
      await page.goto("/finance/expense-reports");
      await openRow(page, "accExpenseReports", `${prefix}EXP`);
      const report = page.getByRole("dialog", { name: /报销单详情/ });
      await expect(
        report.getByRole("grid", { name: "报销行" }),
      ).toContainText(`${prefix}手工费用`);
      await report.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(report).toBeHidden();
      const createReportButton = page.getByRole("button", {
        name: "新增",
        exact: true,
      });
      await expect(createReportButton).toBeVisible();
      await createReportButton.click();
      const createReport = page.getByRole("dialog", { name: /新增报销单/ });
      await expect(createReport).toContainText("报销行");
      await createReport
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(createReport).toBeHidden();
    });

    await test.step("承兑交易、OCR 与持有动作入口", async () => {
      await page.goto("/finance/acceptance");
      await expect(page).toHaveURL(/\/finance\/acceptance\/transactions$/);
      await openRow(page, "accBillTransactions", `${prefix}BT`);
      const transaction = page.getByRole("dialog", { name: /承兑交易详情/ });
      await expect(transaction).toContainText(`${prefix}BILL`);
      await transaction
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      await expect(transaction).toBeHidden();
      const createTransactionButton = page.getByRole("button", {
        name: "新增承兑接收",
      });
      await expect(createTransactionButton).toBeVisible();
      await createTransactionButton.click();
      const createTransaction = page.getByRole("dialog", {
        name: /新增承兑接收/,
      });
      await expect(createTransaction).toContainText("票面信息");
      await expect(createTransaction).toContainText("OCR");
      await createTransaction
        .getByRole("button", { name: "取消", exact: true })
        .click();
      await expect(createTransaction).toBeHidden();
      const holdingsTab = page.getByRole("tab", { name: "持有承兑" });
      await expect(holdingsTab).toBeVisible();
      await holdingsTab.click();
      await expect(page).toHaveURL(/\/finance\/acceptance\/holdings$/);
      const holdings = await grid(page, "accBillHoldings");
      const holdingRow = holdings
        .getByRole("row")
        .filter({ hasText: `${prefix}BILL` })
        .first();
      await expect(holdingRow).toContainText("10");
      const holdingActions = holdingRow.getByRole("button", {
        name: "行操作",
      });
      await expect(holdingActions).toBeVisible();
      await holdingActions.click();
      await expect(
        page.getByRole("menuitem", { name: /转让|兑付|贴现|调拨/ }).first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("断言 REST 路径且 GraphQL/pageErrors 为零", async () => {
      const requiredPaths = [
        "/api/v1/finance/bank-accounts/query",
        "/api/v1/finance/bank-transactions/query",
        "/api/v1/finance/bank-import-templates/query",
        "/api/v1/finance/bank-imports/query",
        `/api/v1/finance/bank-imports/${fixture!.importID}`,
        "/api/v1/finance/bank-reconciliations/query",
        "/api/v1/finance/vat-invoices/query",
        `/api/v1/finance/vat-invoices/${fixture!.invoiceID}`,
        "/api/v1/finance/expense-reports/query",
        "/api/v1/finance/expense-report-items/query",
        "/api/v1/finance/bill-transactions/query",
        `/api/v1/finance/bill-transactions/${fixture!.billTransactionID}`,
        "/api/v1/finance/bill-holdings/query",
      ];
      for (const path of requiredPaths) {
        expect(
          financeREST.some((entry) => entry.endsWith(path)),
          `缺少 Finance REST 请求 ${path}\n${financeREST.join("\n")}`,
        ).toBeTruthy();
      }
      expect(
        graphql,
        `Finance 页面意外访问 GraphQL:\n${graphql.join("\n")}`,
      ).toEqual([]);
      expect(
        pageErrors,
        `Finance 页面运行时错误:\n${pageErrors.join("\n")}`,
      ).toEqual([]);
    });
  } finally {
    cleanup(fixture);
  }
});
