package account

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var directions = map[string]struct{}{"debit": {}, "credit": {}}

var roles = map[string]struct{}{
	"UNBILLED_RECEIVABLE": {}, "RECEIVABLE": {}, "ADVANCE_RECEIVED": {},
	"UNBILLED_PAYABLE": {}, "PAYABLE": {}, "OTHER_PAYABLE": {},
	"ADVANCE_PAID": {}, "TRAVEL": {}, "OFFICE": {}, "ENTERTAINMENT": {},
	"TRANSPORT": {}, "OTHER_EXPENSE": {},
}

var auditedFields = []string{
	"code", "name", "direction", "is_group", "active", "role",
	"parent_id", "company_id", "currency_id",
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Account, error) {
	normalizeCreate(&input)
	if err := validateInput(input); err != nil {
		return Account{}, err
	}
	if !actor.CanAccessCompany(input.CompanyID) {
		return Account{}, apierror.New(apierror.CodeForbidden, "无权访问该公司")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "创建会计科目失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx, input.CompanyID); err != nil {
		return Account{}, err
	}
	if err := validateRelations(ctx, tx, input); err != nil {
		return Account{}, err
	}
	active := true
	if input.Active != nil {
		active = *input.Active
	}
	var item Account
	err = tx.QueryRow(ctx, `
		INSERT INTO bas_account (
			code, name, direction, is_group, active, role,
			parent_id, company_id, currency_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, code, name, direction, is_group, active, role,
		          parent_id, company_id, currency_id, inserted_at, updated_at
	`, input.Code, input.Name, strings.ToLower(input.Direction), input.IsGroup, active, input.Role,
		input.ParentID, input.CompanyID, input.CurrencyID,
	).Scan(&item.ID, &item.Code, &item.Name, &item.Direction, &item.IsGroup, &item.Active,
		&item.Role, &item.ParentID, &item.CompanyID, &item.CurrencyID, &item.InsertedAt, &item.UpdatedAt)
	if err != nil {
		return Account{}, mapWriteError("创建会计科目失败", err)
	}
	normalizeResult(&item)
	item, err = getAccount(ctx, tx, item.ID)
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "读取新会计科目失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_account", RecordID: item.ID, RecordLabel: item.Name,
		CompanyID: &item.CompanyID, ActionType: "create", ActionName: "create",
		Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "创建会计科目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, mapWriteError("创建会计科目失败", err)
	}
	return item, nil
}

func normalizeCreate(input *CreateInput) {
	input.Code = strings.TrimSpace(input.Code)
	input.Name = strings.TrimSpace(input.Name)
	input.Direction = strings.ToLower(strings.TrimSpace(input.Direction))
	if input.Role != nil {
		role := strings.ToUpper(strings.TrimSpace(*input.Role))
		input.Role = &role
	}
	if input.IsGroup {
		input.Role = nil
	}
}

func validateInput(input CreateInput) error {
	fields := map[string][]string{}
	if input.Code == "" || utf8.RuneCountInString(input.Code) > 32 {
		fields["code"] = []string{"不能为空且最多 32 个字符"}
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 128 {
		fields["name"] = []string{"不能为空且最多 128 个字符"}
	}
	if _, ok := directions[input.Direction]; !ok {
		fields["direction"] = []string{"仅支持 DEBIT/CREDIT"}
	}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"不能为空"}
	}
	if input.Role != nil {
		if _, ok := roles[*input.Role]; !ok {
			fields["role"] = []string{"不是有效的科目角色"}
		}
	}
	if len(fields) > 0 {
		return apierror.Validation("会计科目参数不合法", fields)
	}
	return nil
}

func lockTree(ctx context.Context, tx pgx.Tx, companyID uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, companyID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定会计科目树失败", err)
	}
	return nil
}

func validateRelations(ctx context.Context, tx pgx.Tx, input CreateInput) error {
	var companyExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_company WHERE id = $1)`, input.CompanyID).Scan(&companyExists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验公司失败", err)
	}
	if !companyExists {
		return apierror.Validation("会计科目参数不合法", map[string][]string{"companyId": {"公司不存在"}})
	}
	if input.ParentID != nil {
		var parentCompanyID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT company_id FROM bas_account WHERE id = $1`, *input.ParentID).Scan(&parentCompanyID); errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("会计科目参数不合法", map[string][]string{"parentId": {"父科目不存在"}})
		} else if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验父科目失败", err)
		}
		if parentCompanyID != input.CompanyID {
			return apierror.Validation("会计科目参数不合法", map[string][]string{"parentId": {"父科目必须属于同一公司"}})
		}
	}
	if input.CurrencyID != nil {
		var isoCode string
		if err := tx.QueryRow(ctx, `SELECT iso_code FROM bas_currency WHERE id = $1`, *input.CurrencyID).Scan(&isoCode); errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("会计科目参数不合法", map[string][]string{"currencyId": {"币种不存在"}})
		} else if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验币种失败", err)
		}
		if input.Role != nil && !strings.EqualFold(isoCode, "CNY") {
			return apierror.Validation("会计科目参数不合法", map[string][]string{"role": {"外币科目不能设置标准科目角色"}})
		}
	}
	return nil
}

func normalizeResult(item *Account) {
	item.Direction = strings.ToUpper(item.Direction)
	item.InsertedAt = item.InsertedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
}

func snapshot(item Account) map[string]any {
	return map[string]any{
		"code": item.Code, "name": item.Name, "direction": strings.ToLower(item.Direction),
		"is_group": item.IsGroup, "active": item.Active, "role": item.Role,
		"parent_id": item.ParentID, "company_id": item.CompanyID, "currency_id": item.CurrencyID,
	}
}

func mapWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "同一公司内科目编码不能重复", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "会计科目已被引用，不能删除", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
