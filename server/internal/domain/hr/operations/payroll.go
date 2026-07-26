package operations

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	payrollColumns = `p.id,p.month,p.workdays,p.attendance_days,p.missing_days,
		p.overtime_hours,p.daily_wage,p.base_amount,p.allowance,p.bonus,p.fine,
		p.loan_deduction,p.payable,p.status,p.remarks,p.inserted_at,p.updated_at,
		p.employee_id,(SELECT sum(payment.amount) FROM hr_payroll_payment payment
			WHERE payment.payroll_id=p.id)`
	paymentColumns = `id,month,paid_on,amount,kind,remarks,inserted_at,updated_at,
		payroll_id,employee_id,created_by_id`
	loanColumns = `id,kind,occurred_on,amount,remarks,inserted_at,updated_at,
		employee_id,payroll_id,created_by_id`
)

func (s *Service) QueryPayrolls(ctx context.Context, actor *authz.Actor, query ListQuery) (PayrollList, error) {
	if err := requirePermission(actor, "hr.payroll:read"); err != nil {
		return PayrollList{}, err
	}
	if err := validateList(&query); err != nil {
		return PayrollList{}, err
	}
	built, err := filterbuild.Build(PayrollResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return PayrollList{}, err
	}
	var result PayrollList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_payroll`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计工资单失败", err)
	}
	sql, args := appendPagination(`SELECT `+payrollColumns+` FROM hr_payroll p`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询工资单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Payroll, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanPayroll(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取工资单失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetPayroll(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Payroll, error) {
	if err := requirePermission(actor, "hr.payroll:read"); err != nil {
		return Payroll{}, err
	}
	value, err := scanPayroll(s.pool.QueryRow(ctx, `SELECT `+payrollColumns+` FROM hr_payroll p WHERE p.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Payroll{}, apierror.New(apierror.CodeNotFound, "工资单不存在")
	}
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "读取工资单失败", err)
	}
	return value, nil
}

func (s *Service) CreatePayroll(ctx context.Context, actor *authz.Actor, input PayrollInput) (Payroll, error) {
	if err := requirePermission(actor, "hr.payroll:create"); err != nil {
		return Payroll{}, err
	}
	normalized, amounts, err := normalizePayrollInput(input)
	if err != nil {
		return Payroll{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "创建工资单失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := insertPayroll(ctx, tx, normalized, amounts)
	if err != nil {
		return Payroll{}, err
	}
	if err = writeAudit(ctx, tx, actor, "hr_payroll", value.ID, value.Month,
		"create", "create", createdChanges(payrollSnapshot(value))); err != nil {
		return Payroll{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Payroll{}, databaseWriteError("创建工资单失败", err)
	}
	return value, nil
}

func (s *Service) UpdatePayroll(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input PayrollUpdateInput,
) (Payroll, error) {
	if err := requirePermission(actor, "hr.payroll:update"); err != nil {
		return Payroll{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "更新工资单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockPayroll(ctx, tx, id)
	if err != nil {
		return Payroll{}, err
	}
	if before.Status != PayrollPending {
		return Payroll{}, apierror.New(apierror.CodeConflict, "仅待发放工资单可修改或删除,差错请走补发")
	}
	normalized := PayrollInput{
		EmployeeID: before.EmployeeID, Month: before.Month, Workdays: before.Workdays,
		AttendanceDays: before.AttendanceDays, MissingDays: before.MissingDays,
		OvertimeHours: before.OvertimeHours, DailyWage: before.DailyWage,
		Allowance: before.Allowance, Bonus: before.Bonus, Fine: before.Fine,
		LoanDeduction: before.LoanDeduction, Remarks: before.Remarks,
	}
	if input.Workdays != nil {
		normalized.Workdays = *input.Workdays
	}
	if input.AttendanceDays != nil {
		normalized.AttendanceDays = *input.AttendanceDays
	}
	if input.MissingDays != nil {
		normalized.MissingDays = *input.MissingDays
	}
	if input.OvertimeHours != nil {
		normalized.OvertimeHours = *input.OvertimeHours
	}
	if input.DailyWage != nil {
		normalized.DailyWage = *input.DailyWage
	}
	if input.Allowance != nil {
		normalized.Allowance = *input.Allowance
	}
	if input.Bonus != nil {
		normalized.Bonus = *input.Bonus
	}
	if input.Fine != nil {
		normalized.Fine = *input.Fine
	}
	if input.LoanDeduction != nil {
		normalized.LoanDeduction = *input.LoanDeduction
	}
	if input.Remarks.Set {
		normalized.Remarks = input.Remarks.Value
	}
	normalized, amounts, err := normalizePayrollInput(normalized)
	if err != nil {
		return Payroll{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE hr_payroll SET workdays=$2,attendance_days=$3,
		missing_days=$4,overtime_hours=$5,daily_wage=$6,base_amount=$7,allowance=$8,
		bonus=$9,fine=$10,loan_deduction=$11,payable=$12,remarks=$13,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, amounts.Workdays, normalized.AttendanceDays, normalized.MissingDays,
		amounts.OvertimeHours, amounts.DailyWage, amounts.BaseAmount, amounts.Allowance,
		amounts.Bonus, amounts.Fine, amounts.LoanDeduction, amounts.Payable, normalized.Remarks)
	if err != nil {
		return Payroll{}, databaseWriteError("更新工资单失败", err)
	}
	value, err := scanPayroll(tx.QueryRow(ctx, `SELECT `+payrollColumns+` FROM hr_payroll p WHERE p.id=$1`, id))
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "读取工资单失败", err)
	}
	changes := audit.Diff(payrollSnapshot(before), payrollSnapshot(value), payrollAuditFields)
	if len(changes) != 0 {
		if err = writeAudit(ctx, tx, actor, "hr_payroll", id, value.Month,
			"update", "update", changes); err != nil {
			return Payroll{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Payroll{}, databaseWriteError("更新工资单失败", err)
	}
	return value, nil
}

func (s *Service) RefreshPayroll(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Payroll, error) {
	if err := requirePermission(actor, "hr.payroll:update"); err != nil {
		return Payroll{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "重取工资单快照失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockPayroll(ctx, tx, id)
	if err != nil {
		return Payroll{}, err
	}
	if before.Status != PayrollPending {
		return Payroll{}, apierror.New(apierror.CodeConflict, "仅待发放工资单可重取快照")
	}
	snapshot, err := payrollSnapshotForEmployee(ctx, tx, before.Month, before.EmployeeID)
	if err != nil {
		return Payroll{}, err
	}
	input := PayrollInput{
		EmployeeID: before.EmployeeID, Month: before.Month,
		Workdays: snapshot.Workdays, AttendanceDays: snapshot.AttendanceDays,
		MissingDays: snapshot.MissingDays, OvertimeHours: snapshot.OvertimeHours,
		DailyWage: snapshot.DailyWage, Allowance: snapshot.Allowance,
		Bonus: before.Bonus, Fine: before.Fine, LoanDeduction: before.LoanDeduction,
		Remarks: before.Remarks,
	}
	normalized, amounts, err := normalizePayrollInput(input)
	if err != nil {
		return Payroll{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE hr_payroll SET workdays=$2,attendance_days=$3,
		missing_days=$4,overtime_hours=$5,daily_wage=$6,base_amount=$7,allowance=$8,
		bonus=$9,fine=$10,loan_deduction=$11,payable=$12,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, amounts.Workdays, normalized.AttendanceDays, normalized.MissingDays,
		amounts.OvertimeHours, amounts.DailyWage, amounts.BaseAmount, amounts.Allowance,
		amounts.Bonus, amounts.Fine, amounts.LoanDeduction, amounts.Payable)
	if err != nil {
		return Payroll{}, databaseWriteError("重取工资单快照失败", err)
	}
	value, err := scanPayroll(tx.QueryRow(ctx, `SELECT `+payrollColumns+` FROM hr_payroll p WHERE p.id=$1`, id))
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "读取工资单失败", err)
	}
	changes := audit.Diff(payrollSnapshot(before), payrollSnapshot(value), payrollAuditFields)
	if len(changes) != 0 {
		if err = writeAudit(ctx, tx, actor, "hr_payroll", id, value.Month,
			"update", "refresh", changes); err != nil {
			return Payroll{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Payroll{}, databaseWriteError("重取工资单快照失败", err)
	}
	return value, nil
}

func (s *Service) DeletePayroll(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePermission(actor, "hr.payroll:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除工资单失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := lockPayroll(ctx, tx, id)
	if err != nil {
		return err
	}
	if value.Status != PayrollPending {
		return apierror.New(apierror.CodeConflict, "仅待发放工资单可修改或删除,差错请走补发")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM hr_payroll WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除工资单失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_payroll", id, value.Month,
		"destroy", "destroy", destroyedChanges(payrollSnapshot(value))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除工资单失败", err)
	}
	return nil
}

func (s *Service) GeneratePayrolls(
	ctx context.Context,
	actor *authz.Actor,
	month string,
) (PayrollGenerateResult, error) {
	if err := requirePermission(actor, "hr.payroll:create"); err != nil {
		return PayrollGenerateResult{}, err
	}
	first, err := parseMonth(month)
	if err != nil {
		return PayrollGenerateResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PayrollGenerateResult{}, apierror.Wrap(apierror.CodeInternal, "批量生成工资单失败", err)
	}
	defer tx.Rollback(ctx)
	var result PayrollGenerateResult
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM hr_payroll WHERE month=$1`, month).Scan(&result.Skipped); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计既有工资单失败", err)
	}
	rows, err := tx.Query(ctx, `
		SELECT d.employee_id,
		       COALESCE(sum(d.normal_hours),0)/8+COALESCE(sum(d.bonus_workday),0),
		       count(*)::bigint,count(*) FILTER (WHERE d.status='missing')::bigint,
		       COALESCE(sum(d.overtime_hours),0),
		       COALESCE(e.daily_wage,0),COALESCE(e.monthly_allowance,0)
		  FROM hr_attendance_day d JOIN hr_employees e ON e.id=d.employee_id
		 WHERE d.date >= $1 AND d.date < $2
		   AND NOT EXISTS(SELECT 1 FROM hr_payroll p WHERE p.employee_id=d.employee_id AND p.month=$3)
		 GROUP BY d.employee_id,e.daily_wage,e.monthly_allowance
		 ORDER BY d.employee_id`, first, first.AddDate(0, 1, 0), month)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "读取工资生成快照失败", err)
	}
	var inputs []PayrollInput
	for rows.Next() {
		var input PayrollInput
		var workdays, overtime, wage, allowance pgtype.Numeric
		input.Month = month
		if err = rows.Scan(&input.EmployeeID, &workdays, &input.AttendanceDays,
			&input.MissingDays, &overtime, &wage, &allowance); err != nil {
			rows.Close()
			return result, apierror.Wrap(apierror.CodeInternal, "读取工资生成快照失败", err)
		}
		input.Workdays, input.OvertimeHours = numericString(workdays), numericString(overtime)
		input.DailyWage, input.Allowance = numericString(wage), numericString(allowance)
		inputs = append(inputs, input)
	}
	rows.Close()
	for _, input := range inputs {
		normalized, amounts, normalizeErr := normalizePayrollInput(input)
		if normalizeErr != nil {
			return result, normalizeErr
		}
		value, insertErr := insertPayroll(ctx, tx, normalized, amounts)
		if insertErr != nil {
			return result, insertErr
		}
		if insertErr = writeAudit(ctx, tx, actor, "hr_payroll", value.ID, value.Month,
			"create", "create", createdChanges(payrollSnapshot(value))); insertErr != nil {
			return result, insertErr
		}
		result.Created++
	}
	if err = tx.Commit(ctx); err != nil {
		return PayrollGenerateResult{}, databaseWriteError("批量生成工资单失败", err)
	}
	return result, nil
}

func (s *Service) PayrollMonthStats(
	ctx context.Context,
	actor *authz.Actor,
	month string,
) (PayrollMonthStats, error) {
	if err := requirePermission(actor, "hr.payroll:read"); err != nil {
		return PayrollMonthStats{}, err
	}
	if _, err := parseMonth(month); err != nil {
		return PayrollMonthStats{}, err
	}
	var result PayrollMonthStats
	var payable, paid pgtype.Numeric
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::bigint,count(*) FILTER (WHERE p.status='pending')::bigint,
		       COALESCE(sum(p.payable),0),
		       COALESCE((SELECT sum(payment.amount)
		                   FROM hr_payroll_payment payment
		                   JOIN hr_payroll linked ON linked.id=payment.payroll_id
		                  WHERE linked.month=$1),0)
		  FROM hr_payroll p WHERE p.month=$1`, month).
		Scan(&result.Count, &result.PendingCount, &payable, &paid)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "读取工资月统计失败", err)
	}
	result.PayableTotal, result.PaidTotal = numericString(payable), numericString(paid)
	return result, nil
}

func (s *Service) QueryPayrollPayments(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (PayrollPaymentList, error) {
	if err := requirePermission(actor, "hr.payroll_payment:read"); err != nil {
		return PayrollPaymentList{}, err
	}
	if err := validateList(&query); err != nil {
		return PayrollPaymentList{}, err
	}
	built, err := filterbuild.Build(PayrollPaymentResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return PayrollPaymentList{}, err
	}
	var result PayrollPaymentList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_payroll_payment`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计工资发放失败", err)
	}
	sql, args := appendPagination(`SELECT `+paymentColumns+` FROM hr_payroll_payment`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询工资发放失败", err)
	}
	defer rows.Close()
	result.Results = make([]PayrollPayment, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanPayment(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取工资发放失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetPayrollPayment(ctx context.Context, actor *authz.Actor, id uuid.UUID) (PayrollPayment, error) {
	if err := requirePermission(actor, "hr.payroll_payment:read"); err != nil {
		return PayrollPayment{}, err
	}
	value, err := scanPayment(s.pool.QueryRow(ctx, `SELECT `+paymentColumns+` FROM hr_payroll_payment WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return PayrollPayment{}, apierror.New(apierror.CodeNotFound, "工资发放记录不存在")
	}
	if err != nil {
		return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "读取工资发放失败", err)
	}
	return value, nil
}

func (s *Service) CreatePayrollPayment(
	ctx context.Context,
	actor *authz.Actor,
	input PayrollPaymentInput,
) (PayrollPayment, error) {
	if err := requirePermission(actor, "hr.payroll_payment:create"); err != nil {
		return PayrollPayment{}, err
	}
	amount, err := parseDecimal(input.Amount, "amount", false, true)
	if err != nil {
		return PayrollPayment{}, err
	}
	paidOn, err := parseDate(input.PaidOn, "paidOn")
	if err != nil {
		return PayrollPayment{}, err
	}
	return s.createPayment(ctx, actor, input.PayrollID, paidOn, amount, input.Remarks)
}

func (s *Service) PayRemainingPayroll(
	ctx context.Context,
	actor *authz.Actor,
	input PayrollPayRemainingInput,
) (PayrollPayment, error) {
	if err := requirePermission(actor, "hr.payroll_payment:create"); err != nil {
		return PayrollPayment{}, err
	}
	paidOn, err := parseDate(input.PaidOn, "paidOn")
	if err != nil {
		return PayrollPayment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "发放剩余工资失败", err)
	}
	defer tx.Rollback(ctx)
	payroll, err := lockPayroll(ctx, tx, input.PayrollID)
	if err != nil {
		return PayrollPayment{}, err
	}
	var paid pgtype.Numeric
	if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(amount),0) FROM hr_payroll_payment WHERE payroll_id=$1`,
		payroll.ID).Scan(&paid); err != nil {
		return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "读取实发合计失败", err)
	}
	payable, _ := decimal.NewFromString(payroll.Payable)
	remaining := payable.Sub(decimal.RequireFromString(numericString(paid)))
	if !remaining.IsPositive() {
		return PayrollPayment{}, apierror.New(apierror.CodeConflict, "该工资单已无未发差额")
	}
	value, err := createPaymentInTx(ctx, tx, actor, payroll, paidOn, remaining, input.Remarks)
	if err != nil {
		return PayrollPayment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PayrollPayment{}, databaseWriteError("发放剩余工资失败", err)
	}
	return value, nil
}

func (s *Service) createPayment(
	ctx context.Context,
	actor *authz.Actor,
	payrollID uuid.UUID,
	paidOn time.Time,
	amount decimal.Decimal,
	remarks *string,
) (PayrollPayment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "创建工资发放失败", err)
	}
	defer tx.Rollback(ctx)
	payroll, err := lockPayroll(ctx, tx, payrollID)
	if err != nil {
		return PayrollPayment{}, err
	}
	value, err := createPaymentInTx(ctx, tx, actor, payroll, paidOn, amount, remarks)
	if err != nil {
		return PayrollPayment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PayrollPayment{}, databaseWriteError("创建工资发放失败", err)
	}
	return value, nil
}

func createPaymentInTx(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	payroll Payroll,
	paidOn time.Time,
	amount decimal.Decimal,
	remarks *string,
) (PayrollPayment, error) {
	kind := "supplement"
	if payroll.Status == PayrollPending {
		kind = "normal"
		deduction := decimal.RequireFromString(payroll.LoanDeduction)
		if deduction.IsPositive() {
			var balance pgtype.Numeric
			err := tx.QueryRow(ctx, `SELECT COALESCE(sum(CASE kind WHEN 'borrow' THEN amount ELSE -amount END),0)
				FROM hr_employee_loan WHERE employee_id=$1`, payroll.EmployeeID).Scan(&balance)
			if err != nil {
				return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "读取员工借款余额失败", err)
			}
			if decimal.RequireFromString(numericString(balance)).LessThan(deduction) {
				return PayrollPayment{}, apierror.New(apierror.CodeConflict, "借款抵扣超过员工借款余额")
			}
		}
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO hr_payroll_payment(
		month,paid_on,amount,kind,remarks,payroll_id,employee_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		payroll.Month, paidOn, numeric(amount), kind, remarks, payroll.ID,
		payroll.EmployeeID, actorID(actor)).Scan(&id)
	if err != nil {
		return PayrollPayment{}, databaseWriteError("创建工资发放失败", err)
	}
	value, err := scanPayment(tx.QueryRow(ctx, `SELECT `+paymentColumns+` FROM hr_payroll_payment WHERE id=$1`, id))
	if err != nil {
		return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "读取工资发放失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_payroll_payment", id, payroll.Month,
		"create", "create", createdChanges(paymentSnapshot(value))); err != nil {
		return PayrollPayment{}, err
	}
	if kind == "normal" {
		if _, err = tx.Exec(ctx, `UPDATE hr_payroll SET status='paid',
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, payroll.ID); err != nil {
			return PayrollPayment{}, databaseWriteError("更新工资单状态失败", err)
		}
		if err = writeAudit(ctx, tx, actor, "hr_payroll", payroll.ID, payroll.Month,
			"update", "mark_paid", map[string]audit.Change{
				"status": {"from": "pending", "to": "paid"},
			}); err != nil {
			return PayrollPayment{}, err
		}
		deduction := decimal.RequireFromString(payroll.LoanDeduction)
		if deduction.IsPositive() {
			var loanID uuid.UUID
			err = tx.QueryRow(ctx, `INSERT INTO hr_employee_loan(
				kind,occurred_on,amount,employee_id,payroll_id)
				VALUES('repay',$1,$2,$3,$4) RETURNING id`,
				paidOn, numeric(deduction), payroll.EmployeeID, payroll.ID).Scan(&loanID)
			if err != nil {
				return PayrollPayment{}, databaseWriteError("写入自动借款归还失败", err)
			}
			loan, scanErr := scanLoan(tx.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1`, loanID))
			if scanErr != nil {
				return PayrollPayment{}, apierror.Wrap(apierror.CodeInternal, "读取自动借款归还失败", scanErr)
			}
			if err = writeAudit(ctx, tx, actor, "hr_employee_loan", loanID, loan.OccurredOn,
				"create", "auto_repay", createdChanges(loanSnapshot(loan))); err != nil {
				return PayrollPayment{}, err
			}
		}
	}
	return value, nil
}

func (s *Service) DeletePayrollPayment(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePermission(actor, "hr.payroll_payment:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除工资发放失败", err)
	}
	defer tx.Rollback(ctx)
	var payrollID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT payroll_id FROM hr_payroll_payment WHERE id=$1`, id).Scan(&payrollID); errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "工资发放记录不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取工资发放失败", err)
	}
	payroll, err := lockPayroll(ctx, tx, payrollID)
	if err != nil {
		return err
	}
	value, err := scanPayment(tx.QueryRow(ctx, `SELECT `+paymentColumns+` FROM hr_payroll_payment WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定工资发放失败", err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM hr_payroll_payment WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除工资发放失败", err)
	}
	var remaining int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM hr_payroll_payment WHERE payroll_id=$1`, payroll.ID).Scan(&remaining); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "统计剩余发放失败", err)
	}
	normal := value.Kind != nil && *value.Kind == PaymentNormal
	if normal || remaining == 0 {
		if payroll.Status == PayrollPaid {
			if _, err = tx.Exec(ctx, `UPDATE hr_payroll SET status='pending',
				updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, payroll.ID); err != nil {
				return databaseWriteError("回退工资单状态失败", err)
			}
			if err = writeAudit(ctx, tx, actor, "hr_payroll", payroll.ID, payroll.Month,
				"update", "mark_pending", map[string]audit.Change{
					"status": {"from": "paid", "to": "pending"},
				}); err != nil {
				return err
			}
		}
		rows, queryErr := tx.Query(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE payroll_id=$1 FOR UPDATE`, payroll.ID)
		if queryErr != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取自动借款归还失败", queryErr)
		}
		var loans []EmployeeLoan
		for rows.Next() {
			loan, scanErr := scanLoan(rows)
			if scanErr != nil {
				rows.Close()
				return apierror.Wrap(apierror.CodeInternal, "读取自动借款归还失败", scanErr)
			}
			loans = append(loans, loan)
		}
		rows.Close()
		for _, loan := range loans {
			if _, err = tx.Exec(ctx, `DELETE FROM hr_employee_loan WHERE id=$1`, loan.ID); err != nil {
				return databaseWriteError("删除自动借款归还失败", err)
			}
			if err = writeAudit(ctx, tx, actor, "hr_employee_loan", loan.ID, loan.OccurredOn,
				"destroy", "auto_destroy", destroyedChanges(loanSnapshot(loan))); err != nil {
				return err
			}
		}
	}
	if err = writeAudit(ctx, tx, actor, "hr_payroll_payment", id, payroll.Month,
		"destroy", "destroy", destroyedChanges(paymentSnapshot(value))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除工资发放失败", err)
	}
	return nil
}

func (s *Service) QueryEmployeeLoans(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (EmployeeLoanList, error) {
	if err := requirePermission(actor, "hr.employee_loan:read"); err != nil {
		return EmployeeLoanList{}, err
	}
	if err := validateList(&query); err != nil {
		return EmployeeLoanList{}, err
	}
	built, err := filterbuild.Build(EmployeeLoanResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return EmployeeLoanList{}, err
	}
	var result EmployeeLoanList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_employee_loan`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计员工借款失败", err)
	}
	sql, args := appendPagination(`SELECT `+loanColumns+` FROM hr_employee_loan`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询员工借款失败", err)
	}
	defer rows.Close()
	result.Results = make([]EmployeeLoan, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanLoan(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetEmployeeLoan(ctx context.Context, actor *authz.Actor, id uuid.UUID) (EmployeeLoan, error) {
	if err := requirePermission(actor, "hr.employee_loan:read"); err != nil {
		return EmployeeLoan{}, err
	}
	value, err := scanLoan(s.pool.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return EmployeeLoan{}, apierror.New(apierror.CodeNotFound, "员工借款记录不存在")
	}
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", err)
	}
	return value, nil
}

func (s *Service) CreateEmployeeLoan(
	ctx context.Context,
	actor *authz.Actor,
	input EmployeeLoanInput,
) (EmployeeLoan, error) {
	if err := requirePermission(actor, "hr.employee_loan:create"); err != nil {
		return EmployeeLoan{}, err
	}
	kind, occurredOn, amount, err := normalizeLoanInput(input.Kind, input.OccurredOn, input.Amount)
	if err != nil {
		return EmployeeLoan{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "创建员工借款失败", err)
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO hr_employee_loan(
		kind,occurred_on,amount,remarks,employee_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
		kind, occurredOn, numeric(amount), input.Remarks, input.EmployeeID, actorID(actor)).Scan(&id)
	if err != nil {
		return EmployeeLoan{}, databaseWriteError("创建员工借款失败", err)
	}
	value, err := scanLoan(tx.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1`, id))
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_employee_loan", id, value.OccurredOn,
		"create", "create", createdChanges(loanSnapshot(value))); err != nil {
		return EmployeeLoan{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EmployeeLoan{}, databaseWriteError("创建员工借款失败", err)
	}
	return value, nil
}

func (s *Service) UpdateEmployeeLoan(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input EmployeeLoanUpdateInput,
) (EmployeeLoan, error) {
	if err := requirePermission(actor, "hr.employee_loan:update"); err != nil {
		return EmployeeLoan{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "更新员工借款失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanLoan(tx.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return EmployeeLoan{}, apierror.New(apierror.CodeNotFound, "员工借款记录不存在")
	}
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", err)
	}
	if before.PayrollID != nil {
		return EmployeeLoan{}, apierror.New(apierror.CodeConflict, "工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理")
	}
	after := EmployeeLoanInput{
		EmployeeID: before.EmployeeID, Kind: before.Kind, OccurredOn: before.OccurredOn,
		Amount: before.Amount, Remarks: before.Remarks,
	}
	if input.EmployeeID != nil {
		after.EmployeeID = *input.EmployeeID
	}
	if input.Kind != nil {
		after.Kind = *input.Kind
	}
	if input.OccurredOn != nil {
		after.OccurredOn = *input.OccurredOn
	}
	if input.Amount != nil {
		after.Amount = *input.Amount
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	kind, occurredOn, amount, err := normalizeLoanInput(after.Kind, after.OccurredOn, after.Amount)
	if err != nil {
		return EmployeeLoan{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE hr_employee_loan SET kind=$2,occurred_on=$3,
		amount=$4,remarks=$5,employee_id=$6,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`, id, kind, occurredOn, numeric(amount), after.Remarks, after.EmployeeID)
	if err != nil {
		return EmployeeLoan{}, databaseWriteError("更新员工借款失败", err)
	}
	value, err := scanLoan(tx.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1`, id))
	if err != nil {
		return EmployeeLoan{}, apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", err)
	}
	changes := audit.Diff(loanSnapshot(before), loanSnapshot(value), loanAuditFields)
	if len(changes) != 0 {
		if err = writeAudit(ctx, tx, actor, "hr_employee_loan", id, value.OccurredOn,
			"update", "update", changes); err != nil {
			return EmployeeLoan{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return EmployeeLoan{}, databaseWriteError("更新员工借款失败", err)
	}
	return value, nil
}

func (s *Service) DeleteEmployeeLoan(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePermission(actor, "hr.employee_loan:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除员工借款失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := scanLoan(tx.QueryRow(ctx, `SELECT `+loanColumns+` FROM hr_employee_loan WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "员工借款记录不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取员工借款失败", err)
	}
	if value.PayrollID != nil {
		return apierror.New(apierror.CodeConflict, "工资发放联动生成的归还记录不可修改或删除,请从发放记录侧处理")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM hr_employee_loan WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除员工借款失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_employee_loan", id, value.OccurredOn,
		"destroy", "destroy", destroyedChanges(loanSnapshot(value))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除员工借款失败", err)
	}
	return nil
}

func (s *Service) EmployeeLoanBalances(
	ctx context.Context,
	actor *authz.Actor,
) ([]EmployeeLoanBalance, error) {
	if err := requirePermission(actor, "hr.employee_loan:read"); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT l.employee_id,e.code,e.name,
		       COALESCE(sum(l.amount) FILTER (WHERE l.kind='borrow'),0),
		       COALESCE(sum(l.amount) FILTER (WHERE l.kind='repay'),0)
		  FROM hr_employee_loan l JOIN hr_employees e ON e.id=l.employee_id
		 GROUP BY l.employee_id,e.code,e.name ORDER BY e.code,e.name`)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询员工借款余额失败", err)
	}
	defer rows.Close()
	result := make([]EmployeeLoanBalance, 0)
	for rows.Next() {
		var item EmployeeLoanBalance
		var borrowed, repaid pgtype.Numeric
		if err = rows.Scan(&item.EmployeeID, &item.EmployeeCode, &item.EmployeeName,
			&borrowed, &repaid); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取员工借款余额失败", err)
		}
		item.Borrowed, item.Repaid = numericString(borrowed), numericString(repaid)
		item.Balance = decimal.RequireFromString(item.Borrowed).
			Sub(decimal.RequireFromString(item.Repaid)).String()
		result = append(result, item)
	}
	return result, rows.Err()
}

type payrollAmounts struct {
	Workdays, OvertimeHours, DailyWage, BaseAmount, Allowance, Bonus,
	Fine, LoanDeduction, Payable pgtype.Numeric
}

func normalizePayrollInput(input PayrollInput) (PayrollInput, payrollAmounts, error) {
	if input.EmployeeID == uuid.Nil {
		return input, payrollAmounts{}, apierror.Validation("工资单参数不合法", map[string][]string{"employeeId": {"不能为空"}})
	}
	if _, err := parseMonth(input.Month); err != nil {
		return input, payrollAmounts{}, err
	}
	if input.AttendanceDays < 0 || input.MissingDays < 0 {
		return input, payrollAmounts{}, apierror.Validation("工资单参数不合法", map[string][]string{
			"attendanceDays": {"不能为负数"}, "missingDays": {"不能为负数"},
		})
	}
	values := []*string{
		&input.Workdays, &input.OvertimeHours, &input.DailyWage, &input.Allowance,
		&input.Bonus, &input.Fine, &input.LoanDeduction,
	}
	names := []string{"workdays", "overtimeHours", "dailyWage", "allowance", "bonus", "fine", "loanDeduction"}
	parsed := make([]decimal.Decimal, len(values))
	for i, target := range values {
		if *target == "" {
			*target = "0"
		}
		value, err := parseDecimal(*target, names[i], true, false)
		if err != nil {
			return input, payrollAmounts{}, err
		}
		*target = value.String()
		parsed[i] = value
	}
	base := parsed[0].Mul(parsed[2]).Round(2)
	payable := base.Add(parsed[3]).Add(parsed[4]).Sub(parsed[5]).Sub(parsed[6])
	return input, payrollAmounts{
		Workdays: numeric(parsed[0]), OvertimeHours: numeric(parsed[1]),
		DailyWage: numeric(parsed[2]), BaseAmount: numeric(base),
		Allowance: numeric(parsed[3]), Bonus: numeric(parsed[4]), Fine: numeric(parsed[5]),
		LoanDeduction: numeric(parsed[6]), Payable: numeric(payable),
	}, nil
}

func insertPayroll(ctx context.Context, tx pgx.Tx, input PayrollInput, amounts payrollAmounts) (Payroll, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO hr_payroll(
		month,workdays,attendance_days,missing_days,overtime_hours,daily_wage,
		base_amount,allowance,bonus,fine,loan_deduction,payable,remarks,employee_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
		input.Month, amounts.Workdays, input.AttendanceDays, input.MissingDays,
		amounts.OvertimeHours, amounts.DailyWage, amounts.BaseAmount, amounts.Allowance,
		amounts.Bonus, amounts.Fine, amounts.LoanDeduction, amounts.Payable,
		input.Remarks, input.EmployeeID).Scan(&id)
	if err != nil {
		return Payroll{}, databaseWriteError("创建工资单失败", err)
	}
	value, err := scanPayroll(tx.QueryRow(ctx, `SELECT `+payrollColumns+` FROM hr_payroll p WHERE p.id=$1`, id))
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "读取工资单失败", err)
	}
	return value, nil
}

func lockPayroll(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Payroll, error) {
	value, err := scanPayroll(tx.QueryRow(ctx, `SELECT `+payrollColumns+` FROM hr_payroll p WHERE p.id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Payroll{}, apierror.New(apierror.CodeNotFound, "工资单不存在")
	}
	if err != nil {
		return Payroll{}, apierror.Wrap(apierror.CodeInternal, "锁定工资单失败", err)
	}
	return value, nil
}

type payrollRefreshSnapshot struct {
	Workdays, OvertimeHours, DailyWage, Allowance string
	AttendanceDays, MissingDays                   int64
}

func payrollSnapshotForEmployee(
	ctx context.Context,
	tx pgx.Tx,
	month string,
	employeeID uuid.UUID,
) (payrollRefreshSnapshot, error) {
	first, _ := parseMonth(month)
	var result payrollRefreshSnapshot
	var workdays, overtime, wage, allowance pgtype.Numeric
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(sum(d.normal_hours),0)/8+COALESCE(sum(d.bonus_workday),0),
		       count(d.id)::bigint,count(d.id) FILTER (WHERE d.status='missing')::bigint,
		       COALESCE(sum(d.overtime_hours),0),COALESCE(e.daily_wage,0),
		       COALESCE(e.monthly_allowance,0)
		  FROM hr_employees e
		  LEFT JOIN hr_attendance_day d ON d.employee_id=e.id AND d.date >= $2 AND d.date < $3
		 WHERE e.id=$1 GROUP BY e.id,e.daily_wage,e.monthly_allowance`,
		employeeID, first, first.AddDate(0, 1, 0)).
		Scan(&workdays, &result.AttendanceDays, &result.MissingDays, &overtime, &wage, &allowance)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, apierror.New(apierror.CodeConflict, "工资单员工不存在")
	}
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "读取工资快照失败", err)
	}
	result.Workdays, result.OvertimeHours = numericString(workdays), numericString(overtime)
	result.DailyWage, result.Allowance = numericString(wage), numericString(allowance)
	return result, nil
}

func scanPayroll(scanner rowScanner) (Payroll, error) {
	var value Payroll
	var workdays, overtime, wage, base, allowance, bonus, fine, deduction, payable, paid pgtype.Numeric
	err := scanner.Scan(
		&value.ID, &value.Month, &workdays, &value.AttendanceDays, &value.MissingDays,
		&overtime, &wage, &base, &allowance, &bonus, &fine, &deduction, &payable,
		&value.Status, &value.Remarks, &value.InsertedAt, &value.UpdatedAt,
		&value.EmployeeID, &paid,
	)
	value.Workdays, value.OvertimeHours = numericString(workdays), numericString(overtime)
	value.DailyWage, value.BaseAmount = numericString(wage), numericString(base)
	value.Allowance, value.Bonus, value.Fine = numericString(allowance), numericString(bonus), numericString(fine)
	value.LoanDeduction, value.Payable = numericString(deduction), numericString(payable)
	value.PaidTotal = nullableNumericString(paid)
	value.Status = upperWire(value.Status)
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

func scanPayment(scanner rowScanner) (PayrollPayment, error) {
	var value PayrollPayment
	var paidOn time.Time
	var amount pgtype.Numeric
	var kind *string
	err := scanner.Scan(
		&value.ID, &value.Month, &paidOn, &amount, &kind, &value.Remarks,
		&value.InsertedAt, &value.UpdatedAt, &value.PayrollID,
		&value.EmployeeID, &value.CreatedByID,
	)
	value.PaidOn, value.Amount = paidOn.Format("2006-01-02"), numericString(amount)
	if kind != nil {
		wire := upperWire(*kind)
		value.Kind = &wire
	}
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

func scanLoan(scanner rowScanner) (EmployeeLoan, error) {
	var value EmployeeLoan
	var occurredOn time.Time
	var amount pgtype.Numeric
	err := scanner.Scan(
		&value.ID, &value.Kind, &occurredOn, &amount, &value.Remarks,
		&value.InsertedAt, &value.UpdatedAt, &value.EmployeeID,
		&value.PayrollID, &value.CreatedByID,
	)
	value.Kind, value.OccurredOn, value.Amount =
		upperWire(value.Kind), occurredOn.Format("2006-01-02"), numericString(amount)
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

var payrollAuditFields = []string{
	"month", "workdays", "attendance_days", "missing_days", "overtime_hours",
	"daily_wage", "base_amount", "allowance", "bonus", "fine", "loan_deduction",
	"payable", "status", "remarks", "employee_id",
}

func payrollSnapshot(value Payroll) map[string]any {
	return map[string]any{
		"month": value.Month, "workdays": value.Workdays, "attendance_days": value.AttendanceDays,
		"missing_days": value.MissingDays, "overtime_hours": value.OvertimeHours,
		"daily_wage": value.DailyWage, "base_amount": value.BaseAmount,
		"allowance": value.Allowance, "bonus": value.Bonus, "fine": value.Fine,
		"loan_deduction": value.LoanDeduction, "payable": value.Payable,
		"status": lowerWire(value.Status), "remarks": value.Remarks, "employee_id": value.EmployeeID,
	}
}

func paymentSnapshot(value PayrollPayment) map[string]any {
	var kind any
	if value.Kind != nil {
		kind = lowerWire(*value.Kind)
	}
	return map[string]any{
		"month": value.Month, "paid_on": value.PaidOn, "amount": value.Amount,
		"kind": kind, "remarks": value.Remarks, "payroll_id": value.PayrollID,
		"employee_id": value.EmployeeID, "created_by_id": value.CreatedByID,
	}
}

var loanAuditFields = []string{
	"kind", "occurred_on", "amount", "remarks", "employee_id", "payroll_id", "created_by_id",
}

func loanSnapshot(value EmployeeLoan) map[string]any {
	return map[string]any{
		"kind": lowerWire(value.Kind), "occurred_on": value.OccurredOn,
		"amount": value.Amount, "remarks": value.Remarks, "employee_id": value.EmployeeID,
		"payroll_id": value.PayrollID, "created_by_id": value.CreatedByID,
	}
}

func normalizeLoanInput(kind, occurredOn, amount string) (string, time.Time, decimal.Decimal, error) {
	kind = lowerWire(kind)
	if kind != "borrow" && kind != "repay" {
		return "", time.Time{}, decimal.Zero, apierror.Validation("员工借款参数不合法", map[string][]string{
			"kind": {"必须是 BORROW 或 REPAY"},
		})
	}
	date, err := parseDate(occurredOn, "occurredOn")
	if err != nil {
		return "", time.Time{}, decimal.Zero, err
	}
	value, err := parseDecimal(amount, "amount", false, false)
	if err != nil {
		return "", time.Time{}, decimal.Zero, err
	}
	if !value.IsPositive() {
		return "", time.Time{}, decimal.Zero, apierror.Validation("员工借款参数不合法", map[string][]string{
			"amount": {"必须大于零"},
		})
	}
	return kind, date, value, nil
}
