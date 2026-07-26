package companyaccountdefault

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (CompanyAccountDefault, error) {
	if err := require(actor, "read"); err != nil {
		return CompanyAccountDefault{}, err
	}
	if id == uuid.Nil {
		return CompanyAccountDefault{}, apierror.Validation(
			"公司默认过账科目参数不合法", map[string][]string{"id": {"必填"}},
		)
	}
	item, err := scanOne(s.pool.QueryRow(ctx, selectColumns+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(item.CompanyID)) {
		return CompanyAccountDefault{}, notFound()
	}
	if err != nil {
		return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "读取公司默认过账科目失败", err)
	}
	return item, nil
}

func (s *Service) GetByCompany(
	ctx context.Context,
	actor *authz.Actor,
	companyID uuid.UUID,
) (CompanyAccountDefault, error) {
	if err := require(actor, "read"); err != nil {
		return CompanyAccountDefault{}, err
	}
	if companyID == uuid.Nil {
		return CompanyAccountDefault{}, apierror.Validation(
			"公司默认过账科目参数不合法", map[string][]string{"companyId": {"必填"}},
		)
	}
	if !actor.CanAccessCompany(companyID) {
		return CompanyAccountDefault{}, notFound()
	}
	item, err := scanOne(s.pool.QueryRow(ctx, selectColumns+` WHERE company_id=$1`, companyID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CompanyAccountDefault{}, notFound()
	}
	if err != nil {
		return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "读取公司默认过账科目失败", err)
	}
	return item, nil
}

func (s *Service) List(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return ListResult{}, apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "company_id" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询公司默认过账科目失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sal_company_account_default`+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计公司默认过账科目失败", err)
	}
	pageArgs := append([]any(nil), args...)
	limitArg := len(pageArgs) + 1
	pageArgs = append(pageArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, selectColumns+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, limitArg+1), pageArgs...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询公司默认过账科目失败", err)
	}
	defer rows.Close()
	result.Results = make([]CompanyAccountDefault, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanOne(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取公司默认过账科目结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历公司默认过账科目结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成公司默认过账科目查询失败", err)
	}
	return result, nil
}

func (s *Service) Create(
	ctx context.Context,
	actor *authz.Actor,
	input CreateInput,
) (CompanyAccountDefault, error) {
	if err := require(actor, "update"); err != nil {
		return CompanyAccountDefault{}, err
	}
	if input.CompanyID == uuid.Nil {
		return CompanyAccountDefault{}, apierror.Validation(
			"公司默认过账科目参数不合法", map[string][]string{"companyId": {"必填"}},
		)
	}
	if !actor.CanAccessCompany(input.CompanyID) {
		return CompanyAccountDefault{}, notFound()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "创建公司默认过账科目失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateCompany(ctx, tx, input.CompanyID); err != nil {
		return CompanyAccountDefault{}, err
	}
	item := CompanyAccountDefault{
		CompanyID:               input.CompanyID,
		DeliveryDebitAccountID:  input.DeliveryDebitAccountID,
		DeliveryCreditAccountID: input.DeliveryCreditAccountID,
		ReceiptDebitAccountID:   input.ReceiptDebitAccountID,
		ReceiptCreditAccountID:  input.ReceiptCreditAccountID,
	}
	if err := validateAccounts(ctx, tx, item); err != nil {
		return CompanyAccountDefault{}, err
	}
	item, err = scanOne(tx.QueryRow(ctx, `
		INSERT INTO sal_company_account_default(
			company_id,delivery_debit_account_id,delivery_credit_account_id,
			receipt_debit_account_id,receipt_credit_account_id
		) VALUES($1,$2,$3,$4,$5)
		RETURNING id,company_id,delivery_debit_account_id,delivery_credit_account_id,
			receipt_debit_account_id,receipt_credit_account_id,inserted_at,updated_at
	`, item.CompanyID, item.DeliveryDebitAccountID, item.DeliveryCreditAccountID,
		item.ReceiptDebitAccountID, item.ReceiptCreditAccountID))
	if err != nil {
		return CompanyAccountDefault{}, writeError("创建公司默认过账科目失败", err)
	}
	if err := writeAudit(ctx, tx, actor, item, "create", audit.Created(snapshot(item), auditedFields)); err != nil {
		return CompanyAccountDefault{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CompanyAccountDefault{}, writeError("创建公司默认过账科目失败", err)
	}
	return item, nil
}

func (s *Service) Update(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateInput,
) (CompanyAccountDefault, error) {
	if err := require(actor, "update"); err != nil {
		return CompanyAccountDefault{}, err
	}
	if id == uuid.Nil {
		return CompanyAccountDefault{}, apierror.Validation(
			"公司默认过账科目参数不合法", map[string][]string{"id": {"必填"}},
		)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "更新公司默认过账科目失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanOne(tx.QueryRow(ctx, selectColumns+` WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(before.CompanyID)) {
		return CompanyAccountDefault{}, notFound()
	}
	if err != nil {
		return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "读取公司默认过账科目失败", err)
	}
	after := before
	if input.DeliveryDebitAccountID.Set {
		after.DeliveryDebitAccountID = input.DeliveryDebitAccountID.Value
	}
	if input.DeliveryCreditAccountID.Set {
		after.DeliveryCreditAccountID = input.DeliveryCreditAccountID.Value
	}
	if input.ReceiptDebitAccountID.Set {
		after.ReceiptDebitAccountID = input.ReceiptDebitAccountID.Value
	}
	if input.ReceiptCreditAccountID.Set {
		after.ReceiptCreditAccountID = input.ReceiptCreditAccountID.Value
	}
	if err := validateAccounts(ctx, tx, after); err != nil {
		return CompanyAccountDefault{}, err
	}
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return CompanyAccountDefault{}, apierror.Wrap(apierror.CodeInternal, "更新公司默认过账科目失败", err)
		}
		return before, nil
	}
	after, err = scanOne(tx.QueryRow(ctx, `
		UPDATE sal_company_account_default SET
			delivery_debit_account_id=$2,delivery_credit_account_id=$3,
			receipt_debit_account_id=$4,receipt_credit_account_id=$5,
			updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1
		RETURNING id,company_id,delivery_debit_account_id,delivery_credit_account_id,
			receipt_debit_account_id,receipt_credit_account_id,inserted_at,updated_at
	`, id, after.DeliveryDebitAccountID, after.DeliveryCreditAccountID,
		after.ReceiptDebitAccountID, after.ReceiptCreditAccountID))
	if err != nil {
		return CompanyAccountDefault{}, writeError("更新公司默认过账科目失败", err)
	}
	if err := writeAudit(ctx, tx, actor, after, "update", changes); err != nil {
		return CompanyAccountDefault{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CompanyAccountDefault{}, writeError("更新公司默认过账科目失败", err)
	}
	return after, nil
}

func require(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("sales.setting:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限维护公司默认过账科目")
	}
	return nil
}

func validateCompany(ctx context.Context, tx pgx.Tx, companyID uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_company WHERE id=$1)`, companyID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验公司失败", err)
	}
	if !exists {
		return apierror.Validation("公司默认过账科目参数不合法",
			map[string][]string{"companyId": {"公司不存在"}})
	}
	return nil
}

func validateAccounts(ctx context.Context, tx pgx.Tx, item CompanyAccountDefault) error {
	type rule struct {
		field string
		id    *uuid.UUID
		role  string
	}
	rules := []rule{
		{"deliveryDebitAccountId", item.DeliveryDebitAccountID, "unbilled_receivable"},
		{"deliveryCreditAccountId", item.DeliveryCreditAccountID, ""},
		{"receiptDebitAccountId", item.ReceiptDebitAccountID, ""},
		{"receiptCreditAccountId", item.ReceiptCreditAccountID, "unbilled_payable"},
	}
	for _, rule := range rules {
		if rule.id == nil {
			continue
		}
		var companyID uuid.UUID
		var isGroup, active bool
		var role pgtype.Text
		err := tx.QueryRow(ctx, `
			SELECT company_id,is_group,active,role FROM bas_account WHERE id=$1
		`, *rule.id).Scan(&companyID, &isGroup, &active, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return accountValidation(rule.field, "科目不存在")
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验默认过账科目失败", err)
		}
		switch {
		case companyID != item.CompanyID:
			return accountValidation(rule.field, "科目不属于本公司")
		case isGroup:
			return accountValidation(rule.field, "不能选择汇总科目")
		case !active:
			return accountValidation(rule.field, "科目已停用")
		case rule.role != "" && (!role.Valid || role.String != rule.role):
			return accountValidation(rule.field, "科目角色不符合默认过账要求")
		}
	}
	return nil
}

func accountValidation(field, message string) error {
	return apierror.Validation("公司默认过账科目参数不合法",
		map[string][]string{field: {message}})
}

const selectColumns = `SELECT id,company_id,delivery_debit_account_id,
	delivery_credit_account_id,receipt_debit_account_id,receipt_credit_account_id,
	inserted_at,updated_at FROM sal_company_account_default`

type rowScanner interface{ Scan(...any) error }

func scanOne(row rowScanner) (CompanyAccountDefault, error) {
	var item CompanyAccountDefault
	var insertedAt, updatedAt pgtype.Timestamp
	err := row.Scan(&item.ID, &item.CompanyID, &item.DeliveryDebitAccountID,
		&item.DeliveryCreditAccountID, &item.ReceiptDebitAccountID,
		&item.ReceiptCreditAccountID, &insertedAt, &updatedAt)
	if err != nil {
		return CompanyAccountDefault{}, err
	}
	item.InsertedAt = insertedAt.Time.UTC()
	item.UpdatedAt = updatedAt.Time.UTC()
	return item, nil
}

func scopedWhere(actor *authz.Actor, where string, args []any) (string, []any) {
	return filterbuild.ApplyCompanyFilter(actor, where, args, "company_id")
}

func snapshot(item CompanyAccountDefault) map[string]any {
	return map[string]any{
		"company_id":                 item.CompanyID,
		"delivery_debit_account_id":  item.DeliveryDebitAccountID,
		"delivery_credit_account_id": item.DeliveryCreditAccountID,
		"receipt_debit_account_id":   item.ReceiptDebitAccountID,
		"receipt_credit_account_id":  item.ReceiptCreditAccountID,
	}
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	item CompanyAccountDefault,
	action string,
	changes map[string]audit.Change,
) error {
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sal_company_account_default", RecordID: item.ID,
		RecordLabel: item.CompanyID.String(), ActionType: action, ActionName: action,
		CompanyID: &item.CompanyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入公司默认过账科目审计失败", err)
	}
	return nil
}

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "该公司已有默认过账科目配置", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "公司默认过账科目已被业务数据引用", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func notFound() error {
	return apierror.New(apierror.CodeNotFound, "公司默认过账科目不存在")
}
