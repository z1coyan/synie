package quotation

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
	"github.com/z1coyan/synie/server/internal/db/dbgen"
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
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer}
}

func require(actor *authz.Actor, spec sideSpec, action string) error {
	if actor == nil || !actor.HasPermission(spec.prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行该报价操作")
	}
	return nil
}

func pagination(query *ListQuery) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	fields := map[string][]string{}
	if query.Limit < 1 || query.Limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if query.Offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) > 0 {
		return apierror.Validation("分页参数不合法", fields)
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
	at := len(args) + 1
	clause := fmt.Sprintf(`"company_id" = ANY($%d::uuid[])`, at)
	if where == "" {
		where = " WHERE " + clause
	} else {
		where += " AND " + clause
	}
	return where, append(args, companyIDs)
}

func validateQuotationShape(
	spec sideSpec,
	quotationNo string,
	quotationDate, validUntil pgtype.Date,
	partyType string,
	partyID, companyID, currencyID uuid.UUID,
	remarks *string,
) error {
	fields := map[string][]string{}
	if quotationNo == "" || utf8.RuneCountInString(quotationNo) > 32 {
		fields["quotationNo"] = []string{"不能为空且最多 32 个字符"}
	}
	if !quotationDate.Valid {
		fields["quotationDate"] = []string{"必填"}
	}
	if !validUntil.Valid {
		fields["validUntil"] = []string{"必填"}
	} else if quotationDate.Valid && validUntil.Time.Before(quotationDate.Time) {
		fields["validUntil"] = []string{"报价截止不得早于报价日期"}
	}
	partyType = strings.ToLower(strings.TrimSpace(partyType))
	if _, ok := spec.allowedParty[partyType]; !ok {
		if spec.side == SideSales {
			fields["partyType"] = []string{"对手类型只能为客户或内部公司"}
		} else {
			fields["partyType"] = []string{"对手类型只能为供应商或内部公司"}
		}
	}
	if partyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if companyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if currencyID == uuid.Nil {
		fields["currencyId"] = []string{"必填"}
	}
	if partyType == "company" && partyID == companyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(spec.label+"参数不合法", fields)
	}
	return nil
}

func validateParty(ctx context.Context, q *dbgen.Queries, partyType string, partyID uuid.UUID) error {
	exists, err := q.TradingQuotationPartyExists(ctx, dbgen.TradingQuotationPartyExistsParams{
		PartyType: strings.ToLower(strings.TrimSpace(partyType)), PartyID: partyID,
	})
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验报价对手失败", err)
	}
	if !exists {
		return apierror.Validation("报价参数不合法", map[string][]string{"partyId": {"对手不存在"}})
	}
	return nil
}

func lockQuotation(
	ctx context.Context,
	tx pgx.Tx,
	spec sideSpec,
	actor *authz.Actor,
	id uuid.UUID,
) (quotationRow, error) {
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+
		" WHERE q.id=$1 FOR UPDATE OF q", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return quotationRow{}, notFound(spec)
	}
	if err != nil {
		return quotationRow{}, apierror.Wrap(apierror.CodeInternal, "锁定报价单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return quotationRow{}, notFound(spec)
	}
	return row, nil
}

func lockDraftQuotation(
	ctx context.Context,
	tx pgx.Tx,
	spec sideSpec,
	actor *authz.Actor,
	id uuid.UUID,
	child string,
) (quotationRow, error) {
	row, err := lockQuotation(ctx, tx, spec, actor, id)
	if err != nil {
		return quotationRow{}, err
	}
	if row.Status != "draft" {
		message := "仅草稿报价单可修改或删除"
		if child == "item" {
			message = "仅草稿报价单可编辑条目"
		} else if child == "tier" {
			message = "仅草稿报价单可编辑价格档"
		}
		return quotationRow{}, apierror.New(apierror.CodeConflict, message)
	}
	return row, nil
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
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入报价审计失败", err)
	}
	return nil
}

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			switch pgErr.ConstraintName {
			case "sal_quotation_unique_quotation_no_index", "pur_quotation_unique_quotation_no_index":
				return apierror.Wrap(apierror.CodeConflict, "报价单号已存在", err)
			case "sal_quotation_item_unique_material_unit_index", "pur_quotation_item_unique_material_unit_index":
				return apierror.Wrap(apierror.CodeConflict, "同一物料与单位在本报价单已有报价行", err)
			case "sal_quotation_tier_unique_item_min_qty_index", "pur_quotation_tier_unique_item_min_qty_index":
				return apierror.Wrap(apierror.CodeConflict, "同一起订量档已存在", err)
			}
			return apierror.Wrap(apierror.CodeConflict, "报价数据已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "报价数据已被业务引用,不可删除", err)
		case "23514":
			return apierror.Wrap(apierror.CodeValidation, "报价参数不符合约束", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func notFound(spec sideSpec) error {
	return apierror.New(apierror.CodeNotFound, spec.label+"不存在")
}

func itemNotFound() error {
	return apierror.New(apierror.CodeNotFound, "报价条目不存在")
}

func tierNotFound() error {
	return apierror.New(apierror.CodeNotFound, "报价价格档不存在")
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

func dateValue(value pgtype.Date) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return value.Time
}

func date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: !value.IsZero()}
}

func timestampPtr(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func decimalPtr(value pgtype.Numeric) *decimal.Decimal {
	if !value.Valid {
		return nil
	}
	v, err := value.Value()
	if err != nil || v == nil {
		return nil
	}
	result, err := decimal.NewFromString(fmt.Sprint(v))
	if err != nil {
		return nil
	}
	return &result
}
