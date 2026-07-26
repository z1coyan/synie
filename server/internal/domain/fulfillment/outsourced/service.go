package outsourced

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

const (
	issueTable       = "pur_outsourced_issue"
	issueItemTable   = "pur_outsourced_issue_item"
	receiptTable     = "pur_outsourced_receipt"
	receiptItemTable = "pur_outsourced_receipt_item"
	materialTable    = "pur_outsourced_receipt_item_material"
	byproductTable   = "pur_outsourced_receipt_item_byproduct"
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

func require(actor *authz.Actor, prefix, action string) error {
	if actor == nil || !actor.HasPermission(prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行委外履约操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID, message string) error {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return apierror.New(apierror.CodeNotFound, message)
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

func validateCommonHead(companyID uuid.UUID, no string, documentDate time.Time, partyType string, partyID uuid.UUID, remarks *string) error {
	fields := map[string][]string{}
	if strings.TrimSpace(no) == "" || utf8.RuneCountInString(no) > 32 {
		fields["number"] = []string{"不能为空且最多 32 个字符"}
	}
	if documentDate.IsZero() {
		fields["documentDate"] = []string{"必填"}
	}
	partyType = strings.ToLower(strings.TrimSpace(partyType))
	if partyType != "supplier" && partyType != "company" {
		fields["partyType"] = []string{"只允许供应商或内部公司"}
	}
	if partyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if companyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if partyType == "company" && partyID == companyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("委外履约单参数不合法", fields)
	}
	return nil
}

func validateParty(ctx context.Context, tx pgx.Tx, partyType string, partyID uuid.UUID) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		ELSE false END`, strings.ToLower(partyType), partyID).Scan(&exists)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验委外对手失败", err)
	}
	if !exists {
		return apierror.Validation("委外履约单参数不合法", map[string][]string{"partyId": {"对手不存在"}})
	}
	return nil
}

func validateWarehouse(ctx context.Context, tx pgx.Tx, companyID, warehouseID uuid.UUID) error {
	var rowCompanyID uuid.UUID
	var active, leaf bool
	err := tx.QueryRow(ctx, `SELECT company_id,active,is_leaf FROM inv_warehouse WHERE id=$1`, warehouseID).
		Scan(&rowCompanyID, &active, &leaf)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (rowCompanyID != companyID || !active || !leaf)) {
		return apierror.Validation("委外履约仓库不合法", map[string][]string{"warehouseId": {"须为单据公司启用叶子仓"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验委外履约仓库失败", err)
	}
	return nil
}

func validateOutsourcedWarehouse(ctx context.Context, tx pgx.Tx, companyID uuid.UUID, partyType string, partyID, warehouseID uuid.UUID) error {
	var rowCompanyID uuid.UUID
	var outsourced, active, leaf bool
	var partnerType pgtype.Text
	var partnerID *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT company_id,is_outsourced,active,is_leaf,party_type,party_id
		FROM inv_warehouse WHERE id=$1`, warehouseID).
		Scan(&rowCompanyID, &outsourced, &active, &leaf, &partnerType, &partnerID)
	valid := err == nil && rowCompanyID == companyID && outsourced && active && leaf &&
		partnerType.Valid && strings.EqualFold(partnerType.String, partyType) &&
		partnerID != nil && *partnerID == partyID
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !valid) {
		return apierror.Validation("外协仓不合法", map[string][]string{"outsourcedWarehouseId": {"须为绑定当前对手的本公司启用外协仓"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验外协仓失败", err)
	}
	return nil
}

func deriveBaseQty(ctx context.Context, tx pgx.Tx, materialID, defaultUnitID, unitID uuid.UUID, qty decimal.Decimal) (decimal.Decimal, string, error) {
	if !qty.GreaterThan(decimal.Zero) {
		return decimal.Zero, "", apierror.Validation("委外履约行参数不合法", map[string][]string{"qty": {"必须大于 0"}})
	}
	var name string
	var factor pgtype.Numeric
	err := tx.QueryRow(ctx, `SELECT u.name,mu.factor FROM bas_unit u
		LEFT JOIN inv_material_unit mu ON mu.material_id=$1 AND mu.unit_id=u.id
		WHERE u.id=$2`, materialID, unitID).Scan(&name, &factor)
	if errors.Is(err, pgx.ErrNoRows) {
		return decimal.Zero, "", apierror.Validation("委外履约行参数不合法", map[string][]string{"unitId": {"单位不存在"}})
	}
	if err != nil {
		return decimal.Zero, "", apierror.Wrap(apierror.CodeInternal, "读取委外履约单位失败", err)
	}
	if unitID == defaultUnitID {
		return qty, name, nil
	}
	conversion, ok := numericDecimal(factor)
	if !ok || !conversion.GreaterThan(decimal.Zero) {
		return decimal.Zero, "", apierror.Validation("委外履约行参数不合法", map[string][]string{"unitId": {"单位须为物料默认单位或转换单位"}})
	}
	return qty.Div(conversion).Round(6), name, nil
}

func writeAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, resource string, id uuid.UUID, label, actionType, actionName string, companyID uuid.UUID, changes map[string]audit.Change) error {
	if len(changes) == 0 {
		return nil
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: id, RecordLabel: label, ActionType: actionType,
		ActionName: actionName, CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入委外履约审计失败", err)
	}
	return nil
}

func writeError(label string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, label+"单号或记录已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, label+"已被业务引用,不可删除", err)
		case "23502", "23514":
			return apierror.Wrap(apierror.CodeValidation, label+"参数不符合约束", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, label+"失败", err)
}

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func date(value time.Time) pgtype.Date { return pgtype.Date{Time: value, Valid: !value.IsZero()} }
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
	result := value.Time.UTC()
	return &result
}
func statusFromDB(value string) Status { return Status(strings.ToUpper(value)) }

func numericDecimal(value pgtype.Numeric) (decimal.Decimal, bool) {
	if !value.Valid {
		return decimal.Zero, false
	}
	raw, err := value.Value()
	if err != nil || raw == nil {
		return decimal.Zero, false
	}
	result, err := decimal.NewFromString(fmt.Sprint(raw))
	return result, err == nil
}

func sortedUUIDs(values map[uuid.UUID]struct{}) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j].String() < result[j-1].String(); j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	return result
}
