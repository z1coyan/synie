package documents

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const (
	expenseReportColumns = `id,doc_no,expense_date,posting_date,remarks,status,
		audited_at,inserted_at,updated_at,company_id,employee_id,payment_account_id,
		created_by_id,audited_by_id`
	expenseItemColumns = `id,idx,kind,summary,amount,remarks,inserted_at,updated_at,
		report_id,company_id,invoice_id,expense_account_id`
)

func (s *Service) QueryExpenseReports(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (ExpenseReportList, error) {
	if err := requirePermission(actor, "acc.expense_report:read"); err != nil {
		return ExpenseReportList{}, err
	}
	if err := validateList(&query); err != nil {
		return ExpenseReportList{}, err
	}
	built, err := filterbuild.Build(ExpenseReportResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ExpenseReportList{}, err
	}
	built.Where, built.Args = companyScope(actor, built.Where, built.Args, "company_id")
	var result ExpenseReportList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_expense_report`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计费用报销单失败", err)
	}
	sql, args := appendPagination(`SELECT `+expenseReportColumns+
		` FROM acc_expense_report`+built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询费用报销单失败", err)
	}
	defer rows.Close()
	result.Results = make([]ExpenseReport, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanExpenseReport(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取费用报销单失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetExpenseReport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (ExpenseReport, error) {
	if err := requirePermission(actor, "acc.expense_report:read"); err != nil {
		return ExpenseReport{}, err
	}
	where, args := companyScope(actor, " WHERE id=$1", []any{id}, "company_id")
	item, err := scanExpenseReport(s.pool.QueryRow(ctx,
		`SELECT `+expenseReportColumns+` FROM acc_expense_report`+where, args...))
	if err != nil {
		return ExpenseReport{}, notFound("费用报销单", err)
	}
	return item, nil
}

func (s *Service) CreateExpenseReport(
	ctx context.Context, actor *authz.Actor, input ExpenseReportInput,
) (ExpenseReport, error) {
	if err := requirePermission(actor, "acc.expense_report:create"); err != nil {
		return ExpenseReport{}, err
	}
	if err := requireCompany(actor, input.CompanyID, "费用报销单"); err != nil {
		return ExpenseReport{}, err
	}
	expenseDate, err := parseDate(input.ExpenseDate, "expenseDate")
	if err != nil {
		return ExpenseReport{}, err
	}
	if input.EmployeeID == uuid.Nil || input.PaymentAccountID == uuid.Nil {
		return ExpenseReport{}, apierror.Validation("费用报销单参数不合法",
			map[string][]string{"references": {"员工与付款科目必填"}})
	}
	postingDate, err := dateArg(input.PostingDate, "postingDate")
	if err != nil {
		return ExpenseReport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReport{}, apierror.Wrap(apierror.CodeInternal, "创建费用报销单失败", err)
	}
	defer tx.Rollback(ctx)
	if err = validateEmployeeAndAccount(ctx, tx, input.CompanyID,
		input.EmployeeID, input.PaymentAccountID); err != nil {
		return ExpenseReport{}, err
	}
	docNo := ""
	if input.DocNo != nil {
		docNo = strings.TrimSpace(*input.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "acc.expense_report",
			Values:   map[string]any{"company_id": input.CompanyID, "posting_date": expenseDate},
		})
		if err != nil {
			return ExpenseReport{}, err
		}
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_expense_report(
		id,doc_no,expense_date,posting_date,remarks,company_id,employee_id,
		payment_account_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, docNo, expenseDate, postingDate,
		input.Remarks, input.CompanyID, input.EmployeeID, input.PaymentAccountID, actorID(actor))
	if err != nil {
		return ExpenseReport{}, databaseWriteError("创建费用报销单失败", err)
	}
	result, err := queryExpenseReport(ctx, tx, id, false)
	if err != nil {
		return ExpenseReport{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report", id, docNo,
		"create", "create", &result.CompanyID, createdChanges(expenseReportSnapshot(result))); err != nil {
		return ExpenseReport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReport{}, databaseWriteError("创建费用报销单失败", err)
	}
	return result, nil
}

func (s *Service) UpdateExpenseReport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input ExpenseReportUpdateInput,
) (ExpenseReport, error) {
	if err := requirePermission(actor, "acc.expense_report:update"); err != nil {
		return ExpenseReport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReport{}, apierror.Wrap(apierror.CodeInternal, "更新费用报销单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockExpenseReport(ctx, tx, id, actor)
	if err != nil {
		return ExpenseReport{}, err
	}
	if before.Status != StatusDraft {
		return ExpenseReport{}, apierror.New(apierror.CodeConflict, "仅草稿报销单可修改或删除")
	}
	docNo, expenseDate, postingDate, remarks :=
		before.DocNo, before.ExpenseDate, before.PostingDate, before.Remarks
	employeeID, paymentAccountID := before.EmployeeID, before.PaymentAccountID
	if input.DocNo.Set {
		if input.DocNo.Value == nil || strings.TrimSpace(*input.DocNo.Value) == "" {
			return ExpenseReport{}, apierror.Validation("费用报销单参数不合法",
				map[string][]string{"docNo": {"不能为空"}})
		}
		docNo = strings.TrimSpace(*input.DocNo.Value)
	}
	if input.ExpenseDate != nil {
		expenseDate = *input.ExpenseDate
	}
	applyOptionalString(&postingDate, input.PostingDate)
	if input.Remarks.Set {
		remarks = input.Remarks.Value
	}
	if input.EmployeeID != nil {
		employeeID = *input.EmployeeID
	}
	if input.PaymentAccountID != nil {
		paymentAccountID = *input.PaymentAccountID
	}
	date, err := parseDate(expenseDate, "expenseDate")
	if err != nil {
		return ExpenseReport{}, err
	}
	if err = validateEmployeeAndAccount(ctx, tx, before.CompanyID,
		employeeID, paymentAccountID); err != nil {
		return ExpenseReport{}, err
	}
	posting, err := dateArg(postingDate, "postingDate")
	if err != nil {
		return ExpenseReport{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_expense_report SET doc_no=$2,expense_date=$3,
		posting_date=$4,remarks=$5,employee_id=$6,payment_account_id=$7,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, docNo, date, posting, remarks, employeeID, paymentAccountID)
	if err != nil {
		return ExpenseReport{}, databaseWriteError("更新费用报销单失败", err)
	}
	result, err := queryExpenseReport(ctx, tx, id, false)
	if err != nil {
		return ExpenseReport{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report", id, result.DocNo,
		"update", "update", &result.CompanyID,
		changedValues(expenseReportSnapshot(before), expenseReportSnapshot(result))); err != nil {
		return ExpenseReport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReport{}, databaseWriteError("更新费用报销单失败", err)
	}
	return result, nil
}

func (s *Service) DeleteExpenseReport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := requirePermission(actor, "acc.expense_report:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除费用报销单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockExpenseReport(ctx, tx, id, actor)
	if err != nil {
		return err
	}
	if before.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿报销单可修改或删除")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_expense_report WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除费用报销单失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report", id, before.DocNo,
		"delete", "delete", &before.CompanyID,
		changedValues(expenseReportSnapshot(before), map[string]any{})); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除费用报销单失败", err)
	}
	return nil
}

func (s *Service) AuditExpenseReport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, postingDate string,
) (ExpenseReport, error) {
	if err := requirePermission(actor, "acc.expense_report:audit"); err != nil {
		return ExpenseReport{}, err
	}
	posting, err := parseDate(postingDate, "postingDate")
	if err != nil {
		return ExpenseReport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReport{}, apierror.Wrap(apierror.CodeInternal, "审核费用报销单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockExpenseReport(ctx, tx, id, actor)
	if err != nil {
		return ExpenseReport{}, err
	}
	if before.Status != StatusDraft {
		return ExpenseReport{}, apierror.New(apierror.CodeConflict, "仅草稿报销单可审核")
	}
	if err = validateEmployeeAndAccount(ctx, tx, before.CompanyID,
		before.EmployeeID, before.PaymentAccountID); err != nil {
		return ExpenseReport{}, err
	}
	entries, total, err := expenseEntries(ctx, tx, before)
	if err != nil {
		return ExpenseReport{}, err
	}
	if total.IsZero() {
		return ExpenseReport{}, apierror.New(apierror.CodeConflict, "报销单必须至少有一行")
	}
	now := time.Now().UTC()
	tag, err := tx.Exec(ctx, `UPDATE acc_expense_report SET status='audited',
		posting_date=$2,audited_at=$3,audited_by_id=$4,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1 AND status='draft'`,
		id, posting, now, actorID(actor))
	if err != nil {
		return ExpenseReport{}, databaseWriteError("审核费用报销单失败", err)
	}
	if tag.RowsAffected() != 1 {
		return ExpenseReport{}, apierror.New(apierror.CodeConflict, "报销单已被并发处理")
	}
	entries = append(entries, gl.Entry{
		AccountID: before.PaymentAccountID, Debit: decimal.Zero, Credit: total,
	})
	if err = s.ledger.Post(ctx, tx, gl.Voucher{
		Type: "acc.expense_report", ID: id, No: before.DocNo,
		CompanyID: before.CompanyID, PostingDate: posting,
	}, entries); err != nil {
		return ExpenseReport{}, err
	}
	result, err := queryExpenseReport(ctx, tx, id, false)
	if err != nil {
		return ExpenseReport{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report", id, result.DocNo,
		"update", "audit", &result.CompanyID,
		changedValues(expenseReportSnapshot(before), expenseReportSnapshot(result))); err != nil {
		return ExpenseReport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReport{}, databaseWriteError("审核费用报销单失败", err)
	}
	return result, nil
}

func (s *Service) VoidExpenseReport(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (ExpenseReport, error) {
	if err := requirePermission(actor, "acc.expense_report:void"); err != nil {
		return ExpenseReport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReport{}, apierror.Wrap(apierror.CodeInternal, "作废费用报销单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockExpenseReport(ctx, tx, id, actor)
	if err != nil {
		return ExpenseReport{}, err
	}
	if before.Status != StatusAudited {
		return ExpenseReport{}, apierror.New(apierror.CodeConflict, "仅已审核报销单可作废")
	}
	if err = s.ledger.Cancel(ctx, tx,
		gl.VoucherRef{Type: "acc.expense_report", ID: id}); err != nil {
		return ExpenseReport{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE acc_expense_report SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return ExpenseReport{}, databaseWriteError("作废费用报销单失败", err)
	}
	result, err := queryExpenseReport(ctx, tx, id, false)
	if err != nil {
		return ExpenseReport{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report", id, result.DocNo,
		"update", "void", &result.CompanyID,
		changedValues(expenseReportSnapshot(before), expenseReportSnapshot(result))); err != nil {
		return ExpenseReport{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReport{}, databaseWriteError("作废费用报销单失败", err)
	}
	return result, nil
}

func (s *Service) QueryExpenseReportItems(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (ExpenseReportItemList, error) {
	if err := requirePermission(actor, "acc.expense_report:read"); err != nil {
		return ExpenseReportItemList{}, err
	}
	if err := validateList(&query); err != nil {
		return ExpenseReportItemList{}, err
	}
	built, err := filterbuild.Build(ExpenseReportItemResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ExpenseReportItemList{}, err
	}
	built.Where, built.Args = companyScope(actor, built.Where, built.Args, "company_id")
	var result ExpenseReportItemList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_expense_report_item`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计报销行失败", err)
	}
	sql, args := appendPagination(`SELECT `+expenseItemColumns+
		` FROM acc_expense_report_item`+built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询报销行失败", err)
	}
	defer rows.Close()
	result.Results = make([]ExpenseReportItem, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanExpenseItem(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取报销行失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetExpenseReportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (ExpenseReportItem, error) {
	if err := requirePermission(actor, "acc.expense_report:read"); err != nil {
		return ExpenseReportItem{}, err
	}
	where, args := companyScope(actor, " WHERE id=$1", []any{id}, "company_id")
	item, err := scanExpenseItem(s.pool.QueryRow(ctx,
		`SELECT `+expenseItemColumns+` FROM acc_expense_report_item`+where, args...))
	if err != nil {
		return ExpenseReportItem{}, notFound("报销行", err)
	}
	return item, nil
}

func (s *Service) CreateExpenseReportItem(
	ctx context.Context, actor *authz.Actor, input ExpenseReportItemInput,
) (ExpenseReportItem, error) {
	if err := requirePermission(actor, "acc.expense_report:create"); err != nil {
		return ExpenseReportItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReportItem{}, apierror.Wrap(apierror.CodeInternal, "创建报销行失败", err)
	}
	defer tx.Rollback(ctx)
	report, err := lockExpenseReport(ctx, tx, input.ReportID, actor)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	if report.Status != StatusDraft {
		return ExpenseReportItem{}, apierror.New(apierror.CodeConflict, "仅草稿报销单可增删改行")
	}
	normalized, amount, err := validateExpenseItem(ctx, tx, report, input, uuid.Nil)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_expense_report_item(
		id,idx,kind,summary,amount,remarks,report_id,company_id,invoice_id,expense_account_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, normalized.Idx,
		lower(normalized.Kind), normalized.Summary, amount, normalized.Remarks,
		report.ID, report.CompanyID, normalized.InvoiceID, normalized.ExpenseAccountID)
	if err != nil {
		return ExpenseReportItem{}, databaseWriteError("创建报销行失败", err)
	}
	result, err := queryExpenseItem(ctx, tx, id)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report_item", id,
		report.DocNo+"#"+decimal.NewFromInt(result.Idx).String(), "create", "create",
		&result.CompanyID, createdChanges(expenseItemSnapshot(result))); err != nil {
		return ExpenseReportItem{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReportItem{}, databaseWriteError("创建报销行失败", err)
	}
	return result, nil
}

func (s *Service) UpdateExpenseReportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input ExpenseReportItemUpdateInput,
) (ExpenseReportItem, error) {
	if err := requirePermission(actor, "acc.expense_report:update"); err != nil {
		return ExpenseReportItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExpenseReportItem{}, apierror.Wrap(apierror.CodeInternal, "更新报销行失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryExpenseItem(ctx, tx, id)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	report, err := lockExpenseReport(ctx, tx, before.ReportID, actor)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	if report.Status != StatusDraft {
		return ExpenseReportItem{}, apierror.New(apierror.CodeConflict, "仅草稿报销单可增删改行")
	}
	merged := ExpenseReportItemInput{
		ReportID: before.ReportID, Idx: before.Idx, Kind: before.Kind,
		Summary: before.Summary, Amount: before.Amount, Remarks: before.Remarks,
		InvoiceID: before.InvoiceID, ExpenseAccountID: before.ExpenseAccountID,
	}
	if input.Idx != nil {
		merged.Idx = *input.Idx
	}
	if input.Kind != nil {
		merged.Kind = *input.Kind
	}
	applyOptionalString(&merged.Summary, input.Summary)
	applyOptionalString(&merged.Amount, input.Amount)
	applyOptionalString(&merged.Remarks, input.Remarks)
	applyOptionalUUID(&merged.InvoiceID, input.InvoiceID)
	applyOptionalUUID(&merged.ExpenseAccountID, input.ExpenseAccountID)
	normalized, amount, err := validateExpenseItem(ctx, tx, report, merged, id)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_expense_report_item SET idx=$2,kind=$3,
		summary=$4,amount=$5,remarks=$6,invoice_id=$7,expense_account_id=$8,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, normalized.Idx,
		lower(normalized.Kind), normalized.Summary, amount, normalized.Remarks,
		normalized.InvoiceID, normalized.ExpenseAccountID)
	if err != nil {
		return ExpenseReportItem{}, databaseWriteError("更新报销行失败", err)
	}
	result, err := queryExpenseItem(ctx, tx, id)
	if err != nil {
		return ExpenseReportItem{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report_item", id,
		report.DocNo+"#"+decimal.NewFromInt(result.Idx).String(), "update", "update",
		&result.CompanyID,
		changedValues(expenseItemSnapshot(before), expenseItemSnapshot(result))); err != nil {
		return ExpenseReportItem{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ExpenseReportItem{}, databaseWriteError("更新报销行失败", err)
	}
	return result, nil
}

func (s *Service) DeleteExpenseReportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := requirePermission(actor, "acc.expense_report:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除报销行失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryExpenseItem(ctx, tx, id)
	if err != nil {
		return err
	}
	report, err := lockExpenseReport(ctx, tx, before.ReportID, actor)
	if err != nil {
		return err
	}
	if report.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿报销单可增删改行")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_expense_report_item WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除报销行失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "acc_expense_report_item", id,
		report.DocNo+"#"+decimal.NewFromInt(before.Idx).String(), "delete", "delete",
		&before.CompanyID, changedValues(expenseItemSnapshot(before), map[string]any{})); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除报销行失败", err)
	}
	return nil
}

func validateEmployeeAndAccount(
	ctx context.Context, tx pgx.Tx, companyID, employeeID, accountID uuid.UUID,
) error {
	var employee, account bool
	err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM hr_employees WHERE id=$1),
		EXISTS(SELECT 1 FROM bas_account WHERE id=$2 AND company_id=$3
			AND active AND NOT is_group)`, employeeID, accountID, companyID).
		Scan(&employee, &account)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验报销单引用失败", err)
	}
	if !employee || !account {
		return apierror.Validation("费用报销单参数不合法",
			map[string][]string{"references": {"员工或付款科目不合法"}})
	}
	return nil
}

func validateExpenseItem(
	ctx context.Context, tx pgx.Tx, report ExpenseReport,
	input ExpenseReportItemInput, ownID uuid.UUID,
) (ExpenseReportItemInput, any, error) {
	input.Kind = upper(input.Kind)
	if input.Idx < 1 {
		return input, nil, apierror.Validation("报销行参数不合法",
			map[string][]string{"idx": {"必须大于零"}})
	}
	switch input.Kind {
	case ExpenseInvoiced:
		if input.InvoiceID == nil || input.Summary != nil ||
			input.Amount != nil || input.ExpenseAccountID != nil {
			return input, nil, apierror.Validation("报销行参数不合法",
				map[string][]string{"kind": {"挂票行仅允许发票与备注"}})
		}
		var companyID, partyID uuid.UUID
		var partyType, direction, status string
		var claimed bool
		err := tx.QueryRow(ctx, `SELECT company_id,party_type,party_id,direction,status,
			EXISTS(SELECT 1 FROM acc_expense_report_item other
				JOIN acc_expense_report r ON r.id=other.report_id
				WHERE other.invoice_id=inv.id AND other.id<>$2 AND r.status<>'voided')
			FROM acc_vat_invoice inv WHERE id=$1 FOR UPDATE`,
			*input.InvoiceID, ownID).Scan(&companyID, &partyType, &partyID,
			&direction, &status, &claimed)
		if errors.Is(err, pgx.ErrNoRows) || companyID != report.CompanyID ||
			partyType != "employee" || partyID != report.EmployeeID ||
			direction != "inbound" || status != "audited" || claimed {
			return input, nil, apierror.New(apierror.CodeConflict,
				"挂票发票必须为同公司同员工的已审核未报销开入发票")
		}
		if err != nil {
			return input, nil, apierror.Wrap(apierror.CodeInternal, "校验挂票发票失败", err)
		}
		return input, nil, nil
	case ExpenseManual:
		if input.InvoiceID != nil || input.Summary == nil ||
			strings.TrimSpace(*input.Summary) == "" || input.Amount == nil ||
			input.ExpenseAccountID == nil {
			return input, nil, apierror.Validation("报销行参数不合法",
				map[string][]string{"kind": {"无票行须填写摘要、正金额与费用科目"}})
		}
		amount, err := parseDecimal(*input.Amount, "amount", true, false)
		if err != nil {
			return input, nil, err
		}
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_account
			WHERE id=$1 AND company_id=$2 AND active AND NOT is_group)`,
			*input.ExpenseAccountID, report.CompanyID).Scan(&valid); err != nil || !valid {
			return input, nil, apierror.Validation("报销行参数不合法",
				map[string][]string{"expenseAccountId": {"费用科目不合法"}})
		}
		return input, amount, nil
	default:
		return input, nil, apierror.Validation("报销行参数不合法",
			map[string][]string{"kind": {"只允许 INVOICED 或 MANUAL"}})
	}
}

func expenseEntries(
	ctx context.Context, tx pgx.Tx, report ExpenseReport,
) ([]gl.Entry, decimal.Decimal, error) {
	rows, err := tx.Query(ctx, `SELECT i.kind,i.amount,i.expense_account_id,
		i.invoice_id
		FROM acc_expense_report_item i
		WHERE i.report_id=$1 ORDER BY i.idx,i.id FOR UPDATE OF i`, report.ID)
	if err != nil {
		return nil, decimal.Zero, apierror.Wrap(apierror.CodeInternal, "锁定报销行失败", err)
	}
	type lockedItem struct {
		kind             string
		amount           pgtype.Numeric
		expenseAccountID *uuid.UUID
		invoiceID        *uuid.UUID
	}
	var locked []lockedItem
	for rows.Next() {
		var item lockedItem
		if err = rows.Scan(&item.kind, &item.amount, &item.expenseAccountID,
			&item.invoiceID); err != nil {
			rows.Close()
			return nil, decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取报销行失败", err)
		}
		locked = append(locked, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, decimal.Zero, err
	}
	var entries []gl.Entry
	total := decimal.Zero
	partyType := "employee"
	for _, item := range locked {
		if item.kind == "invoiced" {
			if item.invoiceID == nil {
				return nil, decimal.Zero, apierror.New(apierror.CodeConflict, "挂票行发票状态已变化")
			}
			var gross pgtype.Numeric
			var partyAccountID *uuid.UUID
			err = tx.QueryRow(ctx, `SELECT gross_total,party_account_id
				FROM acc_vat_invoice
				WHERE id=$1 AND company_id=$2 AND party_type='employee' AND party_id=$3
				AND direction='inbound' AND status='audited' FOR UPDATE`,
				*item.invoiceID, report.CompanyID, report.EmployeeID).Scan(&gross, &partyAccountID)
			if err != nil || partyAccountID == nil || !gross.Valid {
				return nil, decimal.Zero, apierror.New(apierror.CodeConflict, "挂票行发票状态已变化")
			}
			var claimed bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM acc_expense_report_item other
				JOIN acc_expense_report r ON r.id=other.report_id
				WHERE other.invoice_id=$1 AND other.report_id<>$2 AND r.status<>'voided')`,
				*item.invoiceID, report.ID).Scan(&claimed); err != nil {
				return nil, decimal.Zero, apierror.Wrap(apierror.CodeInternal,
					"复检挂票占用失败", err)
			}
			if claimed {
				return nil, decimal.Zero, apierror.New(apierror.CodeConflict, "挂票发票已被其他报销单占用")
			}
			value := decimal.NewFromBigInt(gross.Int, gross.Exp)
			entries = append(entries, gl.Entry{
				AccountID: *partyAccountID, Debit: value, Credit: decimal.Zero,
				PartyType: &partyType, PartyID: &report.EmployeeID,
			})
			total = total.Add(value)
		} else {
			if item.expenseAccountID == nil || !item.amount.Valid {
				return nil, decimal.Zero, apierror.New(apierror.CodeConflict, "无票报销行不完整")
			}
			value := decimal.NewFromBigInt(item.amount.Int, item.amount.Exp)
			entries = append(entries, gl.Entry{
				AccountID: *item.expenseAccountID, Debit: value, Credit: decimal.Zero,
			})
			total = total.Add(value)
		}
	}
	return entries, total, nil
}

func queryExpenseReport(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, lock bool,
) (ExpenseReport, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	item, err := scanExpenseReport(tx.QueryRow(ctx,
		`SELECT `+expenseReportColumns+` FROM acc_expense_report WHERE id=$1`+suffix, id))
	if err != nil {
		return item, notFound("费用报销单", err)
	}
	return item, nil
}

func lockExpenseReport(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, actor *authz.Actor,
) (ExpenseReport, error) {
	item, err := queryExpenseReport(ctx, tx, id, true)
	if err != nil {
		return item, err
	}
	if err = requireCompany(actor, item.CompanyID, "费用报销单"); err != nil {
		return ExpenseReport{}, err
	}
	return item, nil
}

func scanExpenseReport(row scanner) (ExpenseReport, error) {
	var item ExpenseReport
	var posting pgtype.Date
	var remarks pgtype.Text
	var audited pgtype.Timestamp
	var expenseDate pgtype.Date
	err := row.Scan(&item.ID, &item.DocNo, &expenseDate, &posting, &remarks,
		&item.Status, &audited, &item.InsertedAt, &item.UpdatedAt, &item.CompanyID,
		&item.EmployeeID, &item.PaymentAccountID, &item.CreatedByID, &item.AuditedByID)
	if err != nil {
		return item, err
	}
	item.ExpenseDate, item.PostingDate = dateValue(expenseDate), datePointer(posting)
	item.Remarks, item.Status = pgText(remarks), upper(item.Status)
	if audited.Valid {
		value := audited.Time.UTC()
		item.AuditedAt = &value
	}
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, nil
}

func queryExpenseItem(ctx context.Context, tx pgx.Tx, id uuid.UUID) (ExpenseReportItem, error) {
	item, err := scanExpenseItem(tx.QueryRow(ctx,
		`SELECT `+expenseItemColumns+` FROM acc_expense_report_item WHERE id=$1`, id))
	if err != nil {
		return item, notFound("报销行", err)
	}
	return item, nil
}

func scanExpenseItem(row scanner) (ExpenseReportItem, error) {
	var item ExpenseReportItem
	var summary, remarks pgtype.Text
	var amount pgtype.Numeric
	err := row.Scan(&item.ID, &item.Idx, &item.Kind, &summary, &amount, &remarks,
		&item.InsertedAt, &item.UpdatedAt, &item.ReportID, &item.CompanyID,
		&item.InvoiceID, &item.ExpenseAccountID)
	if err != nil {
		return item, err
	}
	item.Kind, item.Summary, item.Amount, item.Remarks =
		upper(item.Kind), pgText(summary), decimalPointer(amount), pgText(remarks)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, nil
}

func expenseReportSnapshot(value ExpenseReport) map[string]any {
	return map[string]any{
		"doc_no": value.DocNo, "expense_date": value.ExpenseDate,
		"posting_date": value.PostingDate, "remarks": value.Remarks,
		"status": value.Status, "company_id": value.CompanyID,
		"employee_id": value.EmployeeID, "payment_account_id": value.PaymentAccountID,
	}
}

func expenseItemSnapshot(value ExpenseReportItem) map[string]any {
	return map[string]any{
		"idx": value.Idx, "kind": value.Kind, "summary": value.Summary,
		"amount": value.Amount, "remarks": value.Remarks, "report_id": value.ReportID,
		"company_id": value.CompanyID, "invoice_id": value.InvoiceID,
		"expense_account_id": value.ExpenseAccountID,
	}
}
