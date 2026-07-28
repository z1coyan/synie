package banking

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) GetBankImportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankImportItem, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImportItem{}, err
	}
	item, err := queryBankImportItem(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImportItem{}, notFound("流水导入行")
	}
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入行失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入行"); err != nil {
		return BankImportItem{}, err
	}
	return item, nil
}

func (s *Service) QueryBankImportItems(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankImportItemList, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImportItemList{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[BankImportItem]{
		Pool: s.pool, Resource: BankImportItemResourceMeta(), Label: "流水导入行", Actor: actor,
		Source:       ` FROM acc_bank_import_item`,
		Select:       `SELECT ` + bankImportItemColumns,
		DefaultOrder: ` ORDER BY "row_no","id"`,
		Tiebreaker:   `, "row_no","id"`,
		Scan: func(rows pgx.Rows) (BankImportItem, error) {
			return scanBankImportItem(rows)
		},
	}, listQuery(query))
	if err != nil {
		return BankImportItemList{}, err
	}
	return BankImportItemList{Count: result.Count, Results: result.Results}, nil
}

func (s *Service) UpdateBankImportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BankImportItemUpdateInput,
) (BankImportItem, error) {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return BankImportItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "更新流水导入行失败", err)
	}
	defer tx.Rollback(ctx)
	seed, err := queryBankImportItem(ctx, tx, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImportItem{}, notFound("流水导入行")
	}
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "读取流水导入行失败", err)
	}
	if err := lockParsedImport(ctx, tx, seed.ImportID); err != nil {
		return BankImportItem{}, err
	}
	before, err := queryBankImportItem(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankImportItem{}, notFound("流水导入行")
	}
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "锁定流水导入行失败", err)
	}
	if before.ImportID != seed.ImportID {
		return BankImportItem{}, conflict("流水导入行已被并发修改")
	}
	if err := requireCompany(actor, before.CompanyID, "流水导入行"); err != nil {
		return BankImportItem{}, err
	}
	after := before
	if input.OccurredAt != nil {
		value := input.OccurredAt.UTC()
		after.OccurredAt = &value
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
	if err := validateTransactionShape(valueOrZero(after.OccurredAt), after.Income, after.Expense,
		after.CounterpartyName, after.CounterpartyAccount, after.Summary, after.Note); err != nil {
		return BankImportItem{}, err
	}
	after.Error = nil
	changes := audit.Diff(bankImportItemSnapshot(before), bankImportItemSnapshot(after),
		bankImportItemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return BankImportItem{}, writeError("更新流水导入行失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bank_import_item SET
		occurred_at=$2,income=$3,expense=$4,balance=$5,counterparty_name=$6,
		counterparty_account=$7,summary=$8,note=$9,error=NULL,
		updated_at=timezone('utc',now()) WHERE id=$1`,
		id, after.OccurredAt, after.Income, after.Expense, after.Balance,
		after.CounterpartyName, after.CounterpartyAccount, after.Summary, after.Note)
	if err != nil {
		return BankImportItem{}, writeError("更新流水导入行失败", err)
	}
	item, err := queryBankImportItem(ctx, tx, id, false)
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "读取更新后流水导入行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_item", id,
		importItemLabel(item), "update", "update", &item.CompanyID, changes); err != nil {
		return BankImportItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankImportItem{}, writeError("更新流水导入行失败", err)
	}
	return item, nil
}

func (s *Service) DeleteBankImportItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_transaction", "import"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除流水导入行失败", err)
	}
	defer tx.Rollback(ctx)
	seed, err := queryBankImportItem(ctx, tx, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("流水导入行")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取流水导入行失败", err)
	}
	if err := lockParsedImport(ctx, tx, seed.ImportID); err != nil {
		return err
	}
	item, err := queryBankImportItem(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("流水导入行")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定流水导入行失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "流水导入行"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_import_item WHERE id=$1`, id); err != nil {
		return writeError("删除流水导入行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_item", id,
		importItemLabel(item), "destroy", "destroy", &item.CompanyID,
		audit.Destroyed(bankImportItemSnapshot(item), bankImportItemAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除流水导入行失败", err)
	}
	return nil
}

func createBankImportItemInTx(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor,
	importID, companyID uuid.UUID, input BankImportItem,
) (BankImportItem, error) {
	id := uuid.New()
	_, err := tx.Exec(ctx, `INSERT INTO acc_bank_import_item(
		id,row_no,occurred_at,income,expense,balance,counterparty_name,
		counterparty_account,summary,note,error,import_id,company_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		id, input.RowNo, input.OccurredAt, input.Income, input.Expense, input.Balance,
		input.CounterpartyName, input.CounterpartyAccount, input.Summary, input.Note,
		input.Error, importID, companyID)
	if err != nil {
		return BankImportItem{}, writeError("创建流水导入行失败", err)
	}
	item, err := queryBankImportItem(ctx, tx, id, false)
	if err != nil {
		return BankImportItem{}, apierror.Wrap(apierror.CodeInternal, "读取新建流水导入行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_import_item", id,
		importItemLabel(item), "create", "create", &item.CompanyID,
		audit.Created(bankImportItemSnapshot(item), bankImportItemAuditFields)); err != nil {
		return BankImportItem{}, err
	}
	return item, nil
}

func lockParsedImport(ctx context.Context, tx pgx.Tx, importID uuid.UUID) error {
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM acc_bank_import
		WHERE id=$1 FOR UPDATE`, importID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("流水导入记录")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定流水导入记录失败", err)
	}
	if upper(status) != ImportParsed {
		return conflict("仅「已解析」状态的导入记录可编辑或删除行")
	}
	return nil
}

const bankImportItemColumns = `id,row_no,occurred_at,income,expense,balance,
	counterparty_name,counterparty_account,summary,note,error,inserted_at,updated_at,
	import_id,company_id,transaction_id`

func queryBankImportItem(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankImportItem, error) {
	sql := `SELECT ` + bankImportItemColumns + ` FROM acc_bank_import_item WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanBankImportItem(db.QueryRow(ctx, sql, id))
}

func scanBankImportItem(row rowScanner) (BankImportItem, error) {
	var item BankImportItem
	err := row.Scan(
		&item.ID, &item.RowNo, &item.OccurredAt, &item.Income, &item.Expense,
		&item.Balance, &item.CounterpartyName, &item.CounterpartyAccount,
		&item.Summary, &item.Note, &item.Error, &item.InsertedAt, &item.UpdatedAt,
		&item.ImportID, &item.CompanyID, &item.TransactionID,
	)
	if item.OccurredAt != nil {
		value := item.OccurredAt.UTC()
		item.OccurredAt = &value
	}
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func importItemLabel(item BankImportItem) string {
	return fmt.Sprintf("%s#%d", item.ImportID, item.RowNo)
}

func bankImportItemSnapshot(item BankImportItem) map[string]any {
	return map[string]any{
		"row_no": item.RowNo, "occurred_at": item.OccurredAt,
		"income": item.Income, "expense": item.Expense, "balance": item.Balance,
		"counterparty_name":    item.CounterpartyName,
		"counterparty_account": item.CounterpartyAccount,
		"summary":              item.Summary, "note": item.Note, "error": item.Error,
		"import_id": item.ImportID, "company_id": item.CompanyID,
		"transaction_id": item.TransactionID,
	}
}
