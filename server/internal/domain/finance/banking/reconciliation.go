package banking

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var bankReconciliationAuditFields = []string{
	"amount", "company_id", "bank_transaction_id", "journal_id",
}

type reconciliationJournal struct {
	ID        uuid.UUID
	Status    string
	CompanyID uuid.UUID
}

func (s *Service) GetBankReconciliation(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankReconciliation, error) {
	if err := require(actor, "acc.bank_transaction", "read"); err != nil {
		return BankReconciliation{}, err
	}
	item, err := queryBankReconciliation(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankReconciliation{}, notFound("银行对账记录")
	}
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "读取银行对账记录失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "银行对账记录"); err != nil {
		return BankReconciliation{}, err
	}
	return item, nil
}

func (s *Service) QueryBankReconciliations(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankReconciliationList, error) {
	if err := require(actor, "acc.bank_transaction", "read"); err != nil {
		return BankReconciliationList{}, err
	}
	if err := validatePage(&query); err != nil {
		return BankReconciliationList{}, err
	}
	built, err := buildFilter(BankReconciliationResource, query)
	if err != nil {
		return BankReconciliationList{}, err
	}
	where, args, possible := scopedWhere(actor, built.Where, built.Args, "company_id")
	if !possible {
		return BankReconciliationList{Results: []BankReconciliation{}}, nil
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
		return BankReconciliationList{}, apierror.Wrap(apierror.CodeInternal, "查询银行对账记录失败", err)
	}
	defer tx.Rollback(ctx)
	var result BankReconciliationList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM acc_bank_reconciliation`+where, args...).
		Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计银行对账记录失败", err)
	}
	sql, listArgs := appendPage(`SELECT `+bankReconciliationColumns+`
		FROM acc_bank_reconciliation`+where+order, append([]any(nil), args...), query)
	rows, err := tx.Query(ctx, sql, listArgs...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询银行对账记录失败", err)
	}
	defer rows.Close()
	result.Results = make([]BankReconciliation, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanBankReconciliation(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取银行对账记录结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "遍历银行对账记录结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成银行对账记录查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateBankReconciliation(
	ctx context.Context, actor *authz.Actor, input BankReconciliationCreateInput,
) (BankReconciliation, error) {
	if err := require(actor, "acc.bank_transaction", "reconcile"); err != nil {
		return BankReconciliation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "创建银行对账记录失败", err)
	}
	defer tx.Rollback(ctx)
	transaction, err := queryBankTransaction(ctx, tx, input.BankTransactionID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankReconciliation{}, notFound("银行流水")
	}
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "锁定银行流水失败", err)
	}
	if err := requireCompany(actor, transaction.CompanyID, "银行流水"); err != nil {
		return BankReconciliation{}, err
	}
	item, err := s.createReconciliationLocked(
		ctx, tx, actor, transaction, input.JournalID, input.Amount,
	)
	if err != nil {
		return BankReconciliation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankReconciliation{}, writeError("创建银行对账记录失败", err)
	}
	return item, nil
}

func (s *Service) QuickCreateBankReconciliation(
	ctx context.Context, actor *authz.Actor, input QuickReconciliationInput,
) (BankReconciliation, error) {
	if err := require(actor, "acc.bank_transaction", "reconcile"); err != nil {
		return BankReconciliation{}, err
	}
	// Permission-first includes the two journal capabilities before any record
	// lookup; the injected adapter repeats this as defense in depth.
	if err := require(actor, "acc.gl_journal", "create"); err != nil {
		return BankReconciliation{}, err
	}
	if err := require(actor, "acc.gl_journal", "audit"); err != nil {
		return BankReconciliation{}, err
	}
	fields := map[string][]string{}
	if !input.Amount.IsPositive() {
		fields["amount"] = []string{"对账金额必须大于零"}
	}
	if input.PostingDate.IsZero() {
		fields["postingDate"] = []string{"必填"}
	}
	validateOptionalText(fields, "summary", input.Summary, 255)
	if len(fields) > 0 {
		return BankReconciliation{}, validation("快速对账", fields)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "快速对账失败", err)
	}
	defer tx.Rollback(ctx)
	transaction, err := queryBankTransaction(ctx, tx, input.BankTransactionID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankReconciliation{}, notFound("银行流水")
	}
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "锁定银行流水失败", err)
	}
	if err := requireCompany(actor, transaction.CompanyID, "银行流水"); err != nil {
		return BankReconciliation{}, err
	}
	ledgerAccountID, err := bankLedgerAccount(ctx, tx, transaction)
	if err != nil {
		return BankReconciliation{}, err
	}
	if input.CounterAccountID == ledgerAccountID {
		return BankReconciliation{}, validation("快速对账",
			map[string][]string{"counterAccountId": {"对方科目不能是银行账户绑定的科目"}})
	}
	if err := validateCounterAccount(
		ctx, tx, transaction.CompanyID, input.CounterAccountID,
	); err != nil {
		return BankReconciliation{}, err
	}
	used, err := reconciledTotal(ctx, tx, transaction.ID)
	if err != nil {
		return BankReconciliation{}, err
	}
	remaining := transactionAmount(transaction.Income, transaction.Expense).Sub(used)
	if input.Amount.GreaterThan(remaining) {
		return BankReconciliation{}, validation("快速对账",
			map[string][]string{"amount": {
				"超过流水未对账金额(剩余 " + remaining.String() + ")",
			}})
	}
	journalID, err := s.journals.CreateAndAudit(ctx, tx, actor, QuickJournalInput{
		CompanyID: transaction.CompanyID, BankAccountID: transaction.BankAccountID,
		BankLedgerAccountID: ledgerAccountID, CounterAccountID: input.CounterAccountID,
		BankTransactionID: transaction.ID, Income: transaction.Income != nil,
		Amount: input.Amount, Summary: input.Summary, PostingDate: input.PostingDate,
	})
	if err != nil {
		return BankReconciliation{}, err
	}
	item, err := s.createReconciliationLocked(
		ctx, tx, actor, transaction, journalID, input.Amount,
	)
	if err != nil {
		return BankReconciliation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankReconciliation{}, writeError("快速对账失败", err)
	}
	return item, nil
}

func (s *Service) RemainingBankReconciliation(
	ctx context.Context, actor *authz.Actor, bankTransactionID, journalID uuid.UUID,
) (decimal.Decimal, error) {
	if err := require(actor, "acc.bank_transaction", "read"); err != nil {
		return decimal.Zero, err
	}
	if err := require(actor, "acc.gl_journal", "read"); err != nil {
		return decimal.Zero, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取对账剩余额度失败", err)
	}
	defer tx.Rollback(ctx)
	transaction, err := queryBankTransaction(ctx, tx, bankTransactionID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return decimal.Zero, notFound("银行流水或凭证")
	}
	if err != nil {
		return decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取银行流水失败", err)
	}
	if err := requireCompany(actor, transaction.CompanyID, "银行流水或凭证"); err != nil {
		return decimal.Zero, err
	}
	journal, err := queryReconciliationJournal(ctx, tx, journalID, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && journal.CompanyID != transaction.CompanyID) {
		return decimal.Zero, notFound("银行流水或凭证")
	}
	if err != nil {
		return decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取会计凭证失败", err)
	}
	ledgerAccountID, err := bankLedgerAccountPool(ctx, tx, transaction)
	if err != nil {
		return decimal.Zero, err
	}
	txnUsed, err := reconciledTotalPool(ctx, tx, transaction.ID)
	if err != nil {
		return decimal.Zero, err
	}
	lineTotal, journalUsed, err := journalCapacity(
		ctx, tx, journal.ID, ledgerAccountID, transaction.Income != nil,
	)
	if err != nil {
		return decimal.Zero, err
	}
	txnRemaining := transactionAmount(transaction.Income, transaction.Expense).Sub(txnUsed)
	journalRemaining := lineTotal.Sub(journalUsed)
	if journalRemaining.IsNegative() {
		journalRemaining = decimal.Zero
	}
	result := journalRemaining
	if txnRemaining.LessThan(journalRemaining) {
		result = txnRemaining
	}
	if err := tx.Commit(ctx); err != nil {
		return decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取对账剩余额度失败", err)
	}
	return result, nil
}

func (s *Service) DeleteBankReconciliation(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_transaction", "reconcile"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "解除银行对账失败", err)
	}
	defer tx.Rollback(ctx)
	seed, err := queryBankReconciliation(ctx, tx, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("银行对账记录")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取银行对账记录失败", err)
	}
	transaction, err := queryBankTransaction(ctx, tx, seed.BankTransactionID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("银行流水")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定银行流水失败", err)
	}
	if err := requireCompany(actor, transaction.CompanyID, "银行对账记录"); err != nil {
		return err
	}
	item, err := queryBankReconciliation(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("银行对账记录")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定银行对账记录失败", err)
	}
	if item.BankTransactionID != transaction.ID {
		return conflict("银行对账记录已被并发修改")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_reconciliation WHERE id=$1`, id); err != nil {
		return writeError("解除银行对账失败", err)
	}
	if err := refreshBankTransaction(ctx, tx, transaction); err != nil {
		return err
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_reconciliation", id,
		reconciliationLabel(item), "destroy", "destroy", &item.CompanyID,
		audit.Destroyed(bankReconciliationSnapshot(item),
			bankReconciliationAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("解除银行对账失败", err)
	}
	return nil
}

func (s *Service) createReconciliationLocked(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor,
	transaction BankTransaction, journalID uuid.UUID, amount decimal.Decimal,
) (BankReconciliation, error) {
	ledgerAccountID, err := bankLedgerAccount(ctx, tx, transaction)
	if err != nil {
		return BankReconciliation{}, err
	}
	journal, err := queryReconciliationJournal(ctx, tx, journalID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankReconciliation{}, validation("银行对账",
			map[string][]string{"journalId": {"会计凭证不存在"}})
	}
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "锁定会计凭证失败", err)
	}
	if !amount.IsPositive() {
		return BankReconciliation{}, validation("银行对账",
			map[string][]string{"amount": {"对账金额必须大于零"}})
	}
	if journal.CompanyID != transaction.CompanyID {
		return BankReconciliation{}, validation("银行对账",
			map[string][]string{"journalId": {"凭证与流水必须属于同一公司"}})
	}
	if journal.Status != "audited" {
		return BankReconciliation{}, validation("银行对账",
			map[string][]string{"journalId": {"仅已审核凭证可用于对账"}})
	}
	txnUsed, err := reconciledTotal(ctx, tx, transaction.ID)
	if err != nil {
		return BankReconciliation{}, err
	}
	income := transaction.Income != nil
	lineTotal, journalUsed, err := journalCapacity(
		ctx, tx, journal.ID, ledgerAccountID, income,
	)
	if err != nil {
		return BankReconciliation{}, err
	}
	sideLabel := "贷方"
	if income {
		sideLabel = "借方"
	}
	if !lineTotal.IsPositive() {
		return BankReconciliation{}, validation("银行对账", map[string][]string{
			"journalId": {"凭证不含该银行科目的" + sideLabel + "分录行,方向不匹配"},
		})
	}
	txnRemaining := transactionAmount(transaction.Income, transaction.Expense).Sub(txnUsed)
	if amount.GreaterThan(txnRemaining) {
		return BankReconciliation{}, validation("银行对账", map[string][]string{
			"amount": {"超过流水未对账金额(剩余 " + txnRemaining.String() + ")"},
		})
	}
	journalRemaining := lineTotal.Sub(journalUsed)
	if amount.GreaterThan(journalRemaining) {
		return BankReconciliation{}, validation("银行对账", map[string][]string{
			"amount": {
				"超过凭证可对账余额(该科目" + sideLabel + "剩余 " +
					journalRemaining.String() + ")",
			},
		})
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bank_reconciliation(
		id,amount,company_id,bank_transaction_id,journal_id)
		VALUES($1,$2,$3,$4,$5)`,
		id, amount, transaction.CompanyID, transaction.ID, journal.ID)
	if err != nil {
		return BankReconciliation{}, writeError("创建银行对账记录失败", err)
	}
	if err := refreshBankTransaction(ctx, tx, transaction); err != nil {
		return BankReconciliation{}, err
	}
	item, err := queryBankReconciliation(ctx, tx, id, false)
	if err != nil {
		return BankReconciliation{}, apierror.Wrap(apierror.CodeInternal, "读取新建银行对账记录失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_reconciliation", id,
		reconciliationLabel(item), "create", "create", &item.CompanyID,
		audit.Created(bankReconciliationSnapshot(item),
			bankReconciliationAuditFields)); err != nil {
		return BankReconciliation{}, err
	}
	return item, nil
}

func bankLedgerAccount(
	ctx context.Context, tx pgx.Tx, transaction BankTransaction,
) (uuid.UUID, error) {
	var accountID *uuid.UUID
	// Share-lock the binding after the transaction row and before the journal
	// row. This closes the concurrent account-rebind gap while preserving the
	// global transaction-before-journal lock order.
	err := tx.QueryRow(ctx, `SELECT account_id FROM acc_bank_account
		WHERE id=$1 FOR SHARE`, transaction.BankAccountID).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, notFound("银行账户")
	}
	if err != nil {
		return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取银行账户绑定科目失败", err)
	}
	if accountID == nil {
		return uuid.Nil, validation("银行对账",
			map[string][]string{"bankTransactionId": {"银行账户未绑定会计科目"}})
	}
	return *accountID, nil
}

func bankLedgerAccountPool(
	ctx context.Context, pool interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, transaction BankTransaction,
) (uuid.UUID, error) {
	var accountID *uuid.UUID
	err := pool.QueryRow(ctx, `SELECT account_id FROM acc_bank_account
		WHERE id=$1`, transaction.BankAccountID).Scan(&accountID)
	if err != nil {
		return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取银行账户绑定科目失败", err)
	}
	if accountID == nil {
		return uuid.Nil, validation("银行对账",
			map[string][]string{"bankTransactionId": {"银行账户未绑定会计科目"}})
	}
	return *accountID, nil
}

func validateCounterAccount(
	ctx context.Context, tx pgx.Tx, companyID, accountID uuid.UUID,
) error {
	var (
		accountCompany uuid.UUID
		active, group  bool
	)
	err := tx.QueryRow(ctx, `SELECT company_id,active,is_group
		FROM bas_account WHERE id=$1`, accountID).Scan(&accountCompany, &active, &group)
	if errors.Is(err, pgx.ErrNoRows) {
		return validation("快速对账",
			map[string][]string{"counterAccountId": {"科目不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取快速对账科目失败", err)
	}
	if accountCompany != companyID || !active || group {
		return validation("快速对账", map[string][]string{
			"counterAccountId": {"科目须属于同一公司、启用且非汇总科目"},
		})
	}
	return nil
}

func reconciledTotal(ctx context.Context, tx pgx.Tx, transactionID uuid.UUID) (decimal.Decimal, error) {
	return reconciledTotalPool(ctx, tx, transactionID)
}

func reconciledTotalPool(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, transactionID uuid.UUID,
) (decimal.Decimal, error) {
	var result decimal.Decimal
	if err := db.QueryRow(ctx, `SELECT COALESCE(sum(amount),0)
		FROM acc_bank_reconciliation WHERE bank_transaction_id=$1`,
		transactionID).Scan(&result); err != nil {
		return decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取流水已对账金额失败", err)
	}
	return result, nil
}

func journalCapacity(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, journalID, ledgerAccountID uuid.UUID, income bool,
) (decimal.Decimal, decimal.Decimal, error) {
	column := "credit"
	if income {
		column = "debit"
	}
	var total decimal.Decimal
	if err := db.QueryRow(ctx, `SELECT COALESCE(sum(`+column+`),0)
		FROM acc_gl_journal_line WHERE journal_id=$1 AND account_id=$2`,
		journalID, ledgerAccountID).Scan(&total); err != nil {
		return decimal.Zero, decimal.Zero,
			apierror.Wrap(apierror.CodeInternal, "读取凭证银行科目金额失败", err)
	}
	var used decimal.Decimal
	if err := db.QueryRow(ctx, `SELECT COALESCE(sum(r.amount),0)
		FROM acc_bank_reconciliation r
		JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
		JOIN acc_bank_account b ON b.id=t.bank_account_id
		WHERE r.journal_id=$1 AND b.account_id=$2
		  AND (($3 AND t.income IS NOT NULL) OR (NOT $3 AND t.expense IS NOT NULL))`,
		journalID, ledgerAccountID, income).Scan(&used); err != nil {
		return decimal.Zero, decimal.Zero,
			apierror.Wrap(apierror.CodeInternal, "读取凭证已对账金额失败", err)
	}
	return total, used, nil
}

func refreshBankTransaction(
	ctx context.Context, tx pgx.Tx, transaction BankTransaction,
) error {
	total, err := reconciledTotal(ctx, tx, transaction.ID)
	if err != nil {
		return err
	}
	amount := transactionAmount(transaction.Income, transaction.Expense)
	remaining := amount.Sub(total)
	status := lower(reconcileStatus(total, amount))
	command, err := tx.Exec(ctx, `UPDATE acc_bank_transaction SET
		reconciled_amount=$2,unreconciled_amount=$3,reconcile_status=$4,
		updated_at=timezone('utc',now()) WHERE id=$1`,
		transaction.ID, total, remaining, status)
	if err != nil {
		return writeError("刷新银行流水对账状态失败", err)
	}
	if command.RowsAffected() != 1 {
		return conflict("银行流水已被并发删除")
	}
	return nil
}

func queryReconciliationJournal(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (reconciliationJournal, error) {
	sql := `SELECT id,status,company_id FROM acc_gl_journal WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	var item reconciliationJournal
	err := db.QueryRow(ctx, sql, id).Scan(&item.ID, &item.Status, &item.CompanyID)
	return item, err
}

const bankReconciliationColumns = `id,amount,inserted_at,updated_at,
	company_id,bank_transaction_id,journal_id`

func queryBankReconciliation(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankReconciliation, error) {
	sql := `SELECT ` + bankReconciliationColumns + `
		FROM acc_bank_reconciliation WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanBankReconciliation(db.QueryRow(ctx, sql, id))
}

func scanBankReconciliation(row rowScanner) (BankReconciliation, error) {
	var item BankReconciliation
	err := row.Scan(
		&item.ID, &item.Amount, &item.InsertedAt, &item.UpdatedAt,
		&item.CompanyID, &item.BankTransactionID, &item.JournalID,
	)
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func reconciliationLabel(item BankReconciliation) string {
	return fmt.Sprintf("%s/%s", item.BankTransactionID, item.JournalID)
}

func bankReconciliationSnapshot(item BankReconciliation) map[string]any {
	return map[string]any{
		"amount": item.Amount, "company_id": item.CompanyID,
		"bank_transaction_id": item.BankTransactionID, "journal_id": item.JournalID,
	}
}
