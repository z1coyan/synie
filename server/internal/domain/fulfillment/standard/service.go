package standard

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
	orders   *order.Service
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer, orders: order.NewService(pool)}
}

func (s *Service) GetCompanyAccountDefaults(
	ctx context.Context,
	actor *authz.Actor,
	companyID uuid.UUID,
) (CompanyAccountDefaults, error) {
	if actor == nil || !actor.HasPermission("sales.setting:read") {
		return CompanyAccountDefaults{}, apierror.New(
			apierror.CodeForbidden, "无权限读取公司履约默认科目",
		)
	}
	if companyID == uuid.Nil {
		return CompanyAccountDefaults{}, apierror.Validation(
			"公司履约默认科目参数不合法",
			map[string][]string{"companyId": {"必填"}},
		)
	}
	if !actor.CanAccessCompany(companyID) {
		return CompanyAccountDefaults{}, apierror.New(
			apierror.CodeNotFound, "公司履约默认科目不存在",
		)
	}
	result := CompanyAccountDefaults{CompanyID: companyID}
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT id,delivery_debit_account_id,
		delivery_credit_account_id,receipt_debit_account_id,receipt_credit_account_id
		FROM sal_company_account_default WHERE company_id=$1`, companyID).Scan(
		&id, &result.DeliveryDebitAccountID, &result.DeliveryCreditAccountID,
		&result.ReceiptDebitAccountID, &result.ReceiptCreditAccountID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return CompanyAccountDefaults{}, apierror.Wrap(
			apierror.CodeInternal, "读取公司履约默认科目失败", err,
		)
	}
	result.ID = &id
	return result, nil
}

func require(actor *authz.Actor, spec sideSpec, action string) error {
	if actor == nil || !actor.HasPermission(spec.prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行该履约操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID, notFoundMessage string) error {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return apierror.New(apierror.CodeNotFound, notFoundMessage)
	}
	return nil
}

func validatePage(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	return nil
}

func scopedWhere(actor *authz.Actor, where string, args []any) (string, []any) {
	bypass, companyIDs := actor.CompanyFilter()
	if bypass {
		return where, args
	}
	if len(companyIDs) == 0 {
		return " WHERE false", nil
	}
	clause := fmt.Sprintf(`"company_id"=ANY($%d::uuid[])`, len(args)+1)
	if where == "" {
		where = " WHERE " + clause
	} else {
		where += " AND " + clause
	}
	return where, append(args, companyIDs)
}

func validateHeadShape(spec sideSpec, item Head) error {
	fields := map[string][]string{}
	if strings.TrimSpace(item.No) == "" || utf8.RuneCountInString(item.No) > 32 {
		fields["number"] = []string{"不能为空且最多 32 个字符"}
	}
	if item.DocumentDate.IsZero() {
		fields["documentDate"] = []string{"必填"}
	}
	partyType := strings.ToLower(strings.TrimSpace(item.PartyType))
	if _, ok := spec.allowedPartyType[partyType]; !ok {
		fields["partyType"] = []string{"对手类型不合法"}
	}
	if item.PartyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if item.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if partyType == "company" && item.PartyID == item.CompanyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if item.DebitAccountID == uuid.Nil {
		fields["debitAccountId"] = []string{"必填"}
	}
	if item.CreditAccountID == uuid.Nil {
		fields["creditAccountId"] = []string{"必填"}
	}
	if item.Remarks != nil && utf8.RuneCountInString(*item.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(spec.label+"参数不合法", fields)
	}
	return nil
}

func validateHeadReferences(ctx context.Context, tx pgx.Tx, spec sideSpec, item Head) error {
	var partyExists bool
	if err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=$2)
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		ELSE false END`, strings.ToLower(item.PartyType), item.PartyID).Scan(&partyExists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验履约对手失败", err)
	}
	if !partyExists {
		return apierror.Validation(spec.label+"参数不合法",
			map[string][]string{"partyId": {"对手不存在"}})
	}
	if item.WarehouseID != nil {
		if err := validateWarehouse(ctx, tx, item.CompanyID, *item.WarehouseID); err != nil {
			return err
		}
	}
	type accountInfo struct {
		companyID uuid.UUID
		isGroup   bool
		active    bool
		role      pgtype.Text
	}
	accounts := make(map[uuid.UUID]accountInfo, 2)
	rows, err := tx.Query(ctx, `SELECT id,company_id,is_group,active,role
		FROM bas_account WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{item.DebitAccountID, item.CreditAccountID})
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取履约科目失败", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var account accountInfo
		if err := rows.Scan(&id, &account.companyID, &account.isGroup, &account.active, &account.role); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取履约科目失败", err)
		}
		accounts[id] = account
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "遍历履约科目失败", err)
	}
	for field, id := range map[string]uuid.UUID{
		"debitAccountId": item.DebitAccountID, "creditAccountId": item.CreditAccountID,
	} {
		account, ok := accounts[id]
		if !ok || account.companyID != item.CompanyID || account.isGroup || !account.active {
			return apierror.Validation(spec.label+"参数不合法",
				map[string][]string{field: {"科目须属于单据公司、启用且非汇总"}})
		}
		role := ""
		if account.role.Valid {
			role = account.role.String
		}
		if field == spec.requiredRoleSide+"AccountId" && role != spec.requiredRole {
			return apierror.Validation(spec.label+"参数不合法",
				map[string][]string{field: {"科目角色不符合履约要求"}})
		}
	}
	return nil
}

func validateWarehouse(ctx context.Context, tx pgx.Tx, companyID, warehouseID uuid.UUID) error {
	var rowCompanyID uuid.UUID
	var active, isLeaf bool
	err := tx.QueryRow(ctx, `SELECT company_id,active,is_leaf FROM inv_warehouse WHERE id=$1`,
		warehouseID).Scan(&rowCompanyID, &active, &isLeaf)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (rowCompanyID != companyID || !active || !isLeaf)) {
		return apierror.Validation("履约仓库不合法",
			map[string][]string{"warehouseId": {"须为单据公司启用叶子仓"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验履约仓库失败", err)
	}
	return nil
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	resource string,
	recordID uuid.UUID,
	label, actionType, actionName string,
	companyID uuid.UUID,
	changes map[string]audit.Change,
) error {
	if len(changes) == 0 {
		return nil
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入履约审计失败", err)
	}
	return nil
}

func writeError(spec sideSpec, message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, spec.label+"单号已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, spec.label+"已被业务引用,不可删除", err)
		case "23502", "23514":
			return apierror.Wrap(apierror.CodeValidation, spec.label+"参数不符合约束", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: !value.IsZero()}
}

func timestamp(value time.Time) pgtype.Timestamp {
	return pgtype.Timestamp{Time: value, Valid: !value.IsZero()}
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func textPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func datePtr(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func timestampPtr(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func statusFromDB(value string) Status {
	return Status(strings.ToUpper(value))
}

func decimalZero() decimal.Decimal { return decimal.Zero }
