package banking

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var bankTransactionAuditFields = []string{
	"occurred_at", "income", "expense", "balance", "counterparty_name",
	"counterparty_account", "summary", "note", "company_id", "bank_account_id",
}

func (s *Service) GetBankTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankTransaction, error) {
	if err := require(actor, "acc.bank_transaction", "read"); err != nil {
		return BankTransaction{}, err
	}
	item, err := queryBankTransaction(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankTransaction{}, notFound("银行流水")
	}
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "读取银行流水失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "银行流水"); err != nil {
		return BankTransaction{}, err
	}
	return item, nil
}

func (s *Service) QueryBankTransactions(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankTransactionList, error) {
	if err := require(actor, "acc.bank_transaction", "read"); err != nil {
		return BankTransactionList{}, err
	}
	if err := validatePage(&query); err != nil {
		return BankTransactionList{}, err
	}
	built, err := buildFilter(BankTransactionResource, query)
	if err != nil {
		return BankTransactionList{}, err
	}
	where, args, possible := scopedWhere(actor, built.Where, built.Args, "company_id")
	if !possible {
		return BankTransactionList{Results: []BankTransaction{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "id"`
	} else {
		order += `, "id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return BankTransactionList{}, apierror.Wrap(apierror.CodeInternal, "查询银行流水失败", err)
	}
	defer tx.Rollback(ctx)
	var result BankTransactionList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM acc_bank_transaction`+where, args...).
		Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计银行流水失败", err)
	}
	sql, listArgs := appendPage(`SELECT id,occurred_at,income,expense,balance,
		counterparty_name,counterparty_account,summary,note,reconciled_amount,
		unreconciled_amount,reconcile_status,inserted_at,updated_at,company_id,bank_account_id
		FROM acc_bank_transaction`+where+order, append([]any(nil), args...), query)
	rows, err := tx.Query(ctx, sql, listArgs...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询银行流水失败", err)
	}
	defer rows.Close()
	result.Results = make([]BankTransaction, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBankTransaction(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取银行流水结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历银行流水结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成银行流水查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateBankTransaction(
	ctx context.Context, actor *authz.Actor, input BankTransactionCreateInput,
) (BankTransaction, error) {
	if err := require(actor, "acc.bank_transaction", "create"); err != nil {
		return BankTransaction{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return BankTransaction{}, apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "创建银行流水失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := s.createBankTransactionInTx(ctx, tx, actor, input, true)
	if err != nil {
		return BankTransaction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankTransaction{}, writeError("创建银行流水失败", err)
	}
	return item, nil
}

func (s *Service) createBankTransactionInTx(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor,
	input BankTransactionCreateInput, requireActive bool,
) (BankTransaction, error) {
	if err := validateTransactionShape(input.OccurredAt, input.Income, input.Expense,
		input.CounterpartyName, input.CounterpartyAccount, input.Summary, input.Note); err != nil {
		return BankTransaction{}, err
	}
	if err := validateOwnBankAccount(ctx, tx, input.CompanyID, input.BankAccountID, requireActive); err != nil {
		return BankTransaction{}, err
	}
	amount := transactionAmount(input.Income, input.Expense)
	id := uuid.New()
	_, err := tx.Exec(ctx, `INSERT INTO acc_bank_transaction(
		id,occurred_at,income,expense,balance,counterparty_name,counterparty_account,
		summary,note,reconciled_amount,unreconciled_amount,reconcile_status,
		company_id,bank_account_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,'unreconciled',$11,$12)`,
		id, input.OccurredAt.UTC(), input.Income, input.Expense, input.Balance,
		input.CounterpartyName, input.CounterpartyAccount, input.Summary, input.Note,
		amount, input.CompanyID, input.BankAccountID)
	if err != nil {
		return BankTransaction{}, writeError("创建银行流水失败", err)
	}
	item, err := queryBankTransaction(ctx, tx, id, false)
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "读取新建银行流水失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_transaction", id, transactionLabel(item),
		"create", "create", &item.CompanyID,
		audit.Created(bankTransactionSnapshot(item), bankTransactionAuditFields)); err != nil {
		return BankTransaction{}, err
	}
	return item, nil
}

func (s *Service) UpdateBankTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BankTransactionUpdateInput,
) (BankTransaction, error) {
	if err := require(actor, "acc.bank_transaction", "update"); err != nil {
		return BankTransaction{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "更新银行流水失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryBankTransaction(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankTransaction{}, notFound("银行流水")
	}
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "锁定银行流水失败", err)
	}
	if err := requireCompany(actor, before.CompanyID, "银行流水"); err != nil {
		return BankTransaction{}, err
	}
	after := before
	if input.OccurredAt != nil {
		after.OccurredAt = input.OccurredAt.UTC()
	}
	if input.Income.Set {
		after.Income = input.Income.Value
	}
	if input.Expense.Set {
		after.Expense = input.Expense.Value
	}
	if input.Balance.Set {
		after.Balance = input.Balance.Value
	}
	if input.CounterpartyName.Set {
		after.CounterpartyName = input.CounterpartyName.Value
	}
	if input.CounterpartyAccount.Set {
		after.CounterpartyAccount = input.CounterpartyAccount.Value
	}
	if input.Summary.Set {
		after.Summary = input.Summary.Value
	}
	if input.Note.Set {
		after.Note = input.Note.Value
	}
	if input.BankAccountID != nil {
		after.BankAccountID = *input.BankAccountID
	}
	if err := validateTransactionShape(after.OccurredAt, after.Income, after.Expense,
		after.CounterpartyName, after.CounterpartyAccount, after.Summary, after.Note); err != nil {
		return BankTransaction{}, err
	}
	if err := validateOwnBankAccount(ctx, tx, after.CompanyID, after.BankAccountID, false); err != nil {
		return BankTransaction{}, err
	}
	var total decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(amount),0)
		FROM acc_bank_reconciliation WHERE bank_transaction_id=$1`, id).Scan(&total); err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "读取流水已对账金额失败", err)
	}
	hasLinks := total.IsPositive()
	if hasLinks && before.BankAccountID != after.BankAccountID {
		return BankTransaction{}, conflict("流水已有对账记录,不允许更换银行账户")
	}
	if hasLinks && (before.Income != nil) != (after.Income != nil) {
		return BankTransaction{}, conflict("流水已有对账记录,不允许收支换边")
	}
	amount := transactionAmount(after.Income, after.Expense)
	if amount.LessThan(total) {
		return BankTransaction{}, validation("银行流水",
			map[string][]string{"amount": {"金额不得低于已对账金额(已对账 " + total.String() + ")"}})
	}
	after.ReconciledAmount = total
	after.UnreconciledAmount = amount.Sub(total)
	after.ReconcileStatus = reconcileStatus(total, amount)
	changes := audit.Diff(bankTransactionSnapshot(before), bankTransactionSnapshot(after),
		bankTransactionAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return BankTransaction{}, writeError("更新银行流水失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bank_transaction SET
		occurred_at=$2,income=$3,expense=$4,balance=$5,counterparty_name=$6,
		counterparty_account=$7,summary=$8,note=$9,bank_account_id=$10,
		reconciled_amount=$11,unreconciled_amount=$12,reconcile_status=$13,
		updated_at=timezone('utc',now()) WHERE id=$1`,
		id, after.OccurredAt, after.Income, after.Expense, after.Balance,
		after.CounterpartyName, after.CounterpartyAccount, after.Summary, after.Note,
		after.BankAccountID, total, after.UnreconciledAmount, lower(after.ReconcileStatus))
	if err != nil {
		return BankTransaction{}, writeError("更新银行流水失败", err)
	}
	item, err := queryBankTransaction(ctx, tx, id, false)
	if err != nil {
		return BankTransaction{}, apierror.Wrap(apierror.CodeInternal, "读取更新后银行流水失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_transaction", id, transactionLabel(item),
		"update", "update", &item.CompanyID, changes); err != nil {
		return BankTransaction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankTransaction{}, writeError("更新银行流水失败", err)
	}
	return item, nil
}

func (s *Service) DeleteBankTransaction(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_transaction", "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除银行流水失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := queryBankTransaction(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("银行流水")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定银行流水失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "银行流水"); err != nil {
		return err
	}
	var linked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM acc_bank_reconciliation WHERE bank_transaction_id=$1)`, id).Scan(&linked); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查银行流水对账记录失败", err)
	}
	if linked {
		return conflict("流水已有对账记录,请先解除对账后再删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_transaction WHERE id=$1`, id); err != nil {
		return writeError("删除银行流水失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_transaction", id, transactionLabel(item),
		"destroy", "destroy", &item.CompanyID,
		audit.Destroyed(bankTransactionSnapshot(item), bankTransactionAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除银行流水失败", err)
	}
	return nil
}

func validateTransactionShape(
	occurredAt interface{ IsZero() bool }, income, expense *decimal.Decimal,
	counterpartyName, counterpartyAccount, summary, note *string,
) error {
	fields := map[string][]string{}
	if occurredAt.IsZero() {
		fields["occurredAt"] = []string{"必填"}
	}
	switch {
	case income == nil && expense == nil:
		fields["income"] = []string{"收入或支出必须填写一项"}
	case income != nil && expense != nil:
		fields["expense"] = []string{"收入与支出只能填写一项"}
	case !transactionAmount(income, expense).IsPositive():
		fields["amount"] = []string{"金额必须大于零"}
	}
	validateOptionalText(fields, "counterpartyName", counterpartyName, 128)
	validateOptionalText(fields, "counterpartyAccount", counterpartyAccount, 64)
	validateOptionalText(fields, "summary", summary, 255)
	validateOptionalText(fields, "note", note, 255)
	if len(fields) > 0 {
		return validation("银行流水", fields)
	}
	return nil
}

func validateOwnBankAccount(
	ctx context.Context, tx pgx.Tx, companyID, bankAccountID uuid.UUID, checkActive bool,
) error {
	var accountCompany uuid.UUID
	var active bool
	err := tx.QueryRow(ctx, `SELECT company_id,active FROM acc_bank_account WHERE id=$1`,
		bankAccountID).Scan(&accountCompany, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return validation("银行流水", map[string][]string{"bankAccountId": {"银行账户不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取银行账户失败", err)
	}
	if accountCompany != companyID {
		return validation("银行流水", map[string][]string{"bankAccountId": {"银行账户必须属于同一公司"}})
	}
	if checkActive && !active {
		return validation("银行流水", map[string][]string{"bankAccountId": {"停用银行账户不可用于新增"}})
	}
	return nil
}

func transactionAmount(income, expense *decimal.Decimal) decimal.Decimal {
	if income != nil {
		return *income
	}
	if expense != nil {
		return *expense
	}
	return decimal.Zero
}

func reconcileStatus(reconciled, amount decimal.Decimal) string {
	switch {
	case reconciled.IsZero():
		return ReconcileUnreconciled
	case reconciled.LessThan(amount):
		return ReconcilePartial
	default:
		return ReconcileReconciled
	}
}

func queryBankTransaction(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankTransaction, error) {
	sql := `SELECT id,occurred_at,income,expense,balance,counterparty_name,
		counterparty_account,summary,note,reconciled_amount,unreconciled_amount,
		reconcile_status,inserted_at,updated_at,company_id,bank_account_id
		FROM acc_bank_transaction WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanBankTransaction(db.QueryRow(ctx, sql, id))
}

func scanBankTransaction(row rowScanner) (BankTransaction, error) {
	var item BankTransaction
	var status string
	err := row.Scan(
		&item.ID, &item.OccurredAt, &item.Income, &item.Expense, &item.Balance,
		&item.CounterpartyName, &item.CounterpartyAccount, &item.Summary, &item.Note,
		&item.ReconciledAmount, &item.UnreconciledAmount, &status,
		&item.InsertedAt, &item.UpdatedAt, &item.CompanyID, &item.BankAccountID,
	)
	item.ReconcileStatus = upper(status)
	item.OccurredAt = item.OccurredAt.UTC()
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func transactionLabel(item BankTransaction) string {
	if item.Summary != nil && *item.Summary != "" {
		return *item.Summary
	}
	return item.ID.String()
}

func bankTransactionSnapshot(item BankTransaction) map[string]any {
	return map[string]any{
		"occurred_at": item.OccurredAt, "income": item.Income, "expense": item.Expense,
		"balance": item.Balance, "counterparty_name": item.CounterpartyName,
		"counterparty_account": item.CounterpartyAccount, "summary": item.Summary,
		"note": item.Note, "company_id": item.CompanyID, "bank_account_id": item.BankAccountID,
	}
}
