package sampledata

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

const markerCustomerCode = "C01"

// 财务种子写入的银行账号,作为「示例数据整组成功」标记。
// 不能只用 C01:中途失败时客户已存在,整组跳过会导致 BOM/委外/财务永久缺失。
const markerBankAccountNo = "377601886688901"

func ptr[T any](v T) *T { return &v }

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func daysAgo(n int) time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -n)
}

func dateString(t time.Time) string { return t.Format("2006-01-02") }

func alreadySeeded(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM acc_bank_account WHERE account_no = $1)`, markerBankAccountNo).Scan(&exists)
	if err != nil {
		return false, apierror.Wrap(apierror.CodeInternal, "检查示例数据标记失败", err)
	}
	return exists, nil
}

// partialSampleStarted 表示上次示例种子中途失败(有 C01 但无完成标记)。
func partialSampleStarted(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var hasCustomer, hasBank bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sal_customers WHERE code = $1)`, markerCustomerCode).Scan(&hasCustomer); err != nil {
		return false, apierror.Wrap(apierror.CodeInternal, "检查示例数据进度失败", err)
	}
	if !hasCustomer {
		return false, nil
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM acc_bank_account WHERE account_no = $1)`, markerBankAccountNo).Scan(&hasBank); err != nil {
		return false, apierror.Wrap(apierror.CodeInternal, "检查示例数据进度失败", err)
	}
	return !hasBank, nil
}

// wipePartialSample 清掉中断的示例业务数据,保留公司/科目/仓库/用户与基础种子。
// 仅在 setup 未完成、且检测到半成品示例时调用。
func wipePartialSample(ctx context.Context, pool *pgxpool.Pool) error {
	// RESTART IDENTITY 非必须;CASCADE 按外键清掉示例单据与主数据。
	_, err := pool.Exec(ctx, `
		TRUNCATE TABLE
			acc_vat_invoice,
			acc_expense_report_item,
			acc_expense_report,
			hr_payroll_payment,
			hr_payroll,
			acc_gl_journal_line,
			acc_gl_journal,
			acc_bank_transaction,
			acc_bank_reconciliation,
			acc_bank_import_item,
			acc_bank_import,
			acc_bank_account,
			acc_gl_entry,
			pur_reconciliation_item,
			pur_reconciliation,
			pur_outsourced_receipt_item_byproduct,
			pur_outsourced_receipt_item_material,
			pur_outsourced_receipt_item,
			pur_outsourced_receipt,
			pur_outsourced_issue_item,
			pur_outsourced_issue,
			pur_receipt_item,
			pur_receipt,
			pur_order_item_byproduct,
			pur_order_item_material,
			pur_order_item,
			pur_order,
			pur_quotation_tier,
			pur_quotation_item,
			pur_quotation,
			sal_reconciliation_item,
			sal_reconciliation,
			sal_delivery_item,
			sal_delivery,
			sal_order_item,
			sal_order,
			sal_quotation_tier,
			sal_quotation_item,
			sal_quotation,
			inv_stock_count_item,
			inv_stock_count,
			inv_stock_transfer_item,
			inv_stock_transfer,
			inv_stock_doc_item,
			inv_stock_doc,
			inv_stock_entry,
			mfg_output_item,
			mfg_output,
			mfg_work_order,
			mfg_demand_item,
			mfg_demand,
			mfg_bom_route,
			mfg_bom_byproduct,
			mfg_bom_component,
			mfg_bom,
			mfg_process_template_item,
			mfg_process_template,
			mfg_operation,
			inv_material_unit,
			inv_material,
			hr_attendance_correction,
			hr_attendance_day,
			hr_attendance_punch,
			hr_attendance_import,
			hr_employee_loan,
			hr_employees,
			pur_supplier,
			sal_customers
		RESTART IDENTITY CASCADE`)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "清理中断的示例数据失败", err)
	}
	return nil
}

func unitBySymbol(ctx context.Context, pool *pgxpool.Pool, symbol string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM bas_unit WHERE symbol = $1`, symbol).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要计量单位 %s,请先完成初始化单位种子", symbol))
	}
	return id, nil
}

func leafCategory(ctx context.Context, pool *pgxpool.Pool, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM inv_material_category WHERE code = $1`, code).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要物料分类 %s,请先完成初始化分类种子", code))
	}
	return id, nil
}

func accountByCode(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM bas_account WHERE company_id = $1 AND code = $2`, companyID, code).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要科目 %s(按小企业会计准则模板),请先完成科目表初始化", code))
	}
	return id, nil
}

func warehouseBySuffix(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID, suffix string) (uuid.UUID, string, error) {
	rows, err := pool.Query(ctx, `SELECT id, name FROM inv_warehouse WHERE company_id = $1`, companyID)
	if err != nil {
		return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
		}
		if strings.HasSuffix(name, suffix) {
			return id, name, nil
		}
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	return uuid.Nil, "", apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要名称以「%s」结尾的仓库,请先完成默认仓库种子", suffix))
}

func loadCompany(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID) (companyInfo, error) {
	var c companyInfo
	err := pool.QueryRow(ctx, `
		SELECT id, code, name, short_name, base_currency_id
		FROM bas_company WHERE id = $1`, companyID).
		Scan(&c.ID, &c.Code, &c.Name, &c.ShortName, &c.BaseCurrencyID)
	if err != nil {
		return companyInfo{}, apierror.Wrap(apierror.CodeInternal, "读取示例数据公司失败", err)
	}
	return c, nil
}
