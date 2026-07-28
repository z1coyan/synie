package banking

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var bankAccountAuditFields = []string{
	"alias", "bank_name", "branch_name", "holder_name", "account_no",
	"active", "note", "company_id", "currency_id", "account_id",
}

func (s *Service) GetBankAccount(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (BankAccount, error) {
	if err := require(actor, "acc.bank_account", "read"); err != nil {
		return BankAccount{}, err
	}
	item, err := queryBankAccount(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankAccount{}, notFound("银行账户")
	}
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "读取银行账户失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "银行账户"); err != nil {
		return BankAccount{}, err
	}
	return item, nil
}

func (s *Service) QueryBankAccounts(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (BankAccountList, error) {
	if err := require(actor, "acc.bank_account", "read"); err != nil {
		return BankAccountList{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[BankAccount]{
		Pool: s.pool, Resource: BankAccountResourceMeta(), Label: "银行账户", Actor: actor,
		Source: ` FROM acc_bank_account`,
		Select: `SELECT id,alias,bank_name,branch_name,holder_name,
account_no,active,note,inserted_at,updated_at,company_id,currency_id,account_id`,
		DefaultOrder: ` ORDER BY "id"`,
		Tiebreaker:   `, "id"`,
		Scan: func(rows pgx.Rows) (BankAccount, error) {
			return scanBankAccount(rows)
		},
	}, listQuery(query))
	if err != nil {
		return BankAccountList{}, err
	}
	return BankAccountList{Count: result.Count, Results: result.Results}, nil
}

func (s *Service) CreateBankAccount(
	ctx context.Context, actor *authz.Actor, input BankAccountCreateInput,
) (BankAccount, error) {
	if err := require(actor, "acc.bank_account", "create"); err != nil {
		return BankAccount{}, err
	}
	if actor == nil || !actor.CanAccessCompany(input.CompanyID) {
		return BankAccount{}, apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	fields := map[string][]string{}
	input.Alias = validateRequiredText(fields, "alias", input.Alias, 64)
	input.BankName = validateRequiredText(fields, "bankName", input.BankName, 128)
	input.HolderName = validateRequiredText(fields, "holderName", input.HolderName, 128)
	input.AccountNo = validateRequiredText(fields, "accountNo", input.AccountNo, 64)
	input.BranchName = validateOptionalText(fields, "branchName", input.BranchName, 128)
	input.Note = validateOptionalText(fields, "note", input.Note, 255)
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.CurrencyID == uuid.Nil {
		fields["currencyId"] = []string{"必填"}
	}
	if len(fields) > 0 {
		return BankAccount{}, validation("银行账户", fields)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "创建银行账户失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateBankAccountReferences(ctx, tx, input.CompanyID, input.CurrencyID, input.AccountID); err != nil {
		return BankAccount{}, err
	}
	active := true
	if input.Active != nil {
		active = *input.Active
	}
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO acc_bank_account(
		id,alias,bank_name,branch_name,holder_name,account_no,active,note,
		company_id,currency_id,account_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, input.Alias, input.BankName, input.BranchName, input.HolderName,
		input.AccountNo, active, input.Note, input.CompanyID, input.CurrencyID, input.AccountID)
	if err != nil {
		return BankAccount{}, writeError("创建银行账户失败", err)
	}
	item, err := queryBankAccount(ctx, tx, id, false)
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "读取新建银行账户失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_account", id, item.Alias,
		"create", "create", &item.CompanyID, audit.Created(bankAccountSnapshot(item), bankAccountAuditFields)); err != nil {
		return BankAccount{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankAccount{}, writeError("创建银行账户失败", err)
	}
	return item, nil
}

func (s *Service) UpdateBankAccount(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input BankAccountUpdateInput,
) (BankAccount, error) {
	if err := require(actor, "acc.bank_account", "update"); err != nil {
		return BankAccount{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "更新银行账户失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := queryBankAccount(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return BankAccount{}, notFound("银行账户")
	}
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "锁定银行账户失败", err)
	}
	if err := requireCompany(actor, before.CompanyID, "银行账户"); err != nil {
		return BankAccount{}, err
	}
	after := before
	if input.Alias != nil {
		after.Alias = *input.Alias
	}
	if input.BankName != nil {
		after.BankName = *input.BankName
	}
	if input.BranchName.Set {
		after.BranchName = input.BranchName.Value
	}
	if input.HolderName != nil {
		after.HolderName = *input.HolderName
	}
	if input.AccountNo != nil {
		after.AccountNo = *input.AccountNo
	}
	if input.Active != nil {
		after.Active = *input.Active
	}
	if input.Note.Set {
		after.Note = input.Note.Value
	}
	if input.CurrencyID != nil {
		after.CurrencyID = *input.CurrencyID
	}
	accountChanged := input.AccountID.Set &&
		((before.AccountID == nil) != (input.AccountID.Value == nil) ||
			before.AccountID != nil && input.AccountID.Value != nil && *before.AccountID != *input.AccountID.Value)
	if input.AccountID.Set {
		after.AccountID = input.AccountID.Value
	}
	fields := map[string][]string{}
	after.Alias = validateRequiredText(fields, "alias", after.Alias, 64)
	after.BankName = validateRequiredText(fields, "bankName", after.BankName, 128)
	after.HolderName = validateRequiredText(fields, "holderName", after.HolderName, 128)
	after.AccountNo = validateRequiredText(fields, "accountNo", after.AccountNo, 64)
	after.BranchName = validateOptionalText(fields, "branchName", after.BranchName, 128)
	after.Note = validateOptionalText(fields, "note", after.Note, 255)
	if len(fields) > 0 {
		return BankAccount{}, validation("银行账户", fields)
	}
	if err := validateBankAccountReferences(ctx, tx, after.CompanyID, after.CurrencyID, after.AccountID); err != nil {
		return BankAccount{}, err
	}
	if accountChanged {
		var used bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM acc_bank_reconciliation r
			JOIN acc_bank_transaction t ON t.id=r.bank_transaction_id
			WHERE t.bank_account_id=$1)`, id).Scan(&used); err != nil {
			return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "检查银行账户对账记录失败", err)
		}
		if used {
			return BankAccount{}, conflict("账户名下流水存在对账记录,不允许更换绑定科目,请先解除对账")
		}
	}
	changes := audit.Diff(bankAccountSnapshot(before), bankAccountSnapshot(after), bankAccountAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return BankAccount{}, writeError("更新银行账户失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE acc_bank_account SET
		alias=$2,bank_name=$3,branch_name=$4,holder_name=$5,account_no=$6,
		active=$7,note=$8,currency_id=$9,account_id=$10,updated_at=timezone('utc',now())
		WHERE id=$1`, id, after.Alias, after.BankName, after.BranchName, after.HolderName,
		after.AccountNo, after.Active, after.Note, after.CurrencyID, after.AccountID)
	if err != nil {
		return BankAccount{}, writeError("更新银行账户失败", err)
	}
	item, err := queryBankAccount(ctx, tx, id, false)
	if err != nil {
		return BankAccount{}, apierror.Wrap(apierror.CodeInternal, "读取更新后银行账户失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_account", id, item.Alias,
		"update", "update", &item.CompanyID, changes); err != nil {
		return BankAccount{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BankAccount{}, writeError("更新银行账户失败", err)
	}
	return item, nil
}

func (s *Service) DeleteBankAccount(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "acc.bank_account", "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除银行账户失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := queryBankAccount(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("银行账户")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定银行账户失败", err)
	}
	if err := requireCompany(actor, item.CompanyID, "银行账户"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM acc_bank_account WHERE id=$1`, id); err != nil {
		return writeError("删除银行账户失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "acc_bank_account", id, item.Alias,
		"destroy", "destroy", &item.CompanyID,
		audit.Destroyed(bankAccountSnapshot(item), bankAccountAuditFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除银行账户失败", err)
	}
	return nil
}

func validateBankAccountReferences(
	ctx context.Context, tx pgx.Tx, companyID, currencyID uuid.UUID, accountID *uuid.UUID,
) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_company WHERE id=$1)`,
		companyID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验银行账户公司失败", err)
	}
	if !exists {
		return validation("银行账户", map[string][]string{"companyId": {"公司不存在"}})
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_currency WHERE id=$1)`,
		currencyID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验银行账户货币失败", err)
	}
	if !exists {
		return validation("银行账户", map[string][]string{"currencyId": {"货币不存在"}})
	}
	if accountID == nil {
		return nil
	}
	var accountCompany uuid.UUID
	var isGroup, active bool
	var accountCurrency *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT company_id,is_group,active,currency_id
		FROM bas_account WHERE id=$1`, *accountID).
		Scan(&accountCompany, &isGroup, &active, &accountCurrency)
	if errors.Is(err, pgx.ErrNoRows) {
		return validation("银行账户", map[string][]string{"accountId": {"绑定科目不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取银行账户绑定科目失败", err)
	}
	switch {
	case accountCompany != companyID:
		return validation("银行账户", map[string][]string{"accountId": {"绑定科目必须属于同一公司"}})
	case isGroup:
		return validation("银行账户", map[string][]string{"accountId": {"汇总科目不能绑定银行账户"}})
	case !active:
		return validation("银行账户", map[string][]string{"accountId": {"停用科目不能绑定银行账户"}})
	case accountCurrency != nil && *accountCurrency != currencyID:
		return validation("银行账户", map[string][]string{"accountId": {"绑定科目币种与账户货币不一致"}})
	}
	return nil
}

func queryBankAccount(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (BankAccount, error) {
	sql := `SELECT id,alias,bank_name,branch_name,holder_name,account_no,active,note,
		inserted_at,updated_at,company_id,currency_id,account_id
		FROM acc_bank_account WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanBankAccount(db.QueryRow(ctx, sql, id))
}

type rowScanner interface{ Scan(...any) error }

func scanBankAccount(row rowScanner) (BankAccount, error) {
	var item BankAccount
	err := row.Scan(
		&item.ID, &item.Alias, &item.BankName, &item.BranchName, &item.HolderName,
		&item.AccountNo, &item.Active, &item.Note, &item.InsertedAt, &item.UpdatedAt,
		&item.CompanyID, &item.CurrencyID, &item.AccountID,
	)
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func bankAccountSnapshot(item BankAccount) map[string]any {
	return map[string]any{
		"alias": item.Alias, "bank_name": item.BankName, "branch_name": item.BranchName,
		"holder_name": item.HolderName, "account_no": item.AccountNo, "active": item.Active,
		"note": item.Note, "company_id": item.CompanyID, "currency_id": item.CurrencyID,
		"account_id": item.AccountID,
	}
}
