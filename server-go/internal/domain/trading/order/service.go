package order

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
	quotes   *quotation.Service
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer, quotes: quotation.NewService(pool)}
}

func require(actor *authz.Actor, spec sideSpec, action string) error {
	if actor == nil || !actor.HasPermission(spec.prefix+":"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行该订单操作")
	}
	return nil
}

func requirePurchase(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("purchase.order:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权限执行该采购订单操作")
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
	return filterbuild.ApplyCompanyFilter(actor, where, args, "company_id")
}

func validateOrderShape(spec sideSpec, item Order, remarks *string) error {
	fields := map[string][]string{}
	if strings.TrimSpace(item.OrderNo) == "" || utf8.RuneCountInString(item.OrderNo) > 32 {
		fields["orderNo"] = []string{"不能为空且最多 32 个字符"}
	}
	if item.OrderDate.IsZero() {
		fields["orderDate"] = []string{"必填"}
	}
	orderType := OrderType(strings.ToUpper(strings.TrimSpace(string(item.OrderType))))
	if orderType != OrderTypeRegular && orderType != spec.nonRegularType {
		fields["orderType"] = []string{"订单类型不合法"}
	}
	partyType := strings.ToLower(strings.TrimSpace(item.PartyType))
	if _, ok := spec.allowedParty[partyType]; !ok {
		fields["partyType"] = []string{"对手类型不合法"}
	}
	if item.PartyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if item.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if item.CurrencyID == uuid.Nil {
		fields["currencyId"] = []string{"必填"}
	}
	if partyType == "company" && item.PartyID == item.CompanyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if !item.ExchangeRate.GreaterThan(decimal.Zero) {
		fields["exchangeRate"] = []string{"必须大于 0"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(spec.label+"参数不合法", fields)
	}
	return nil
}

func validateParty(ctx context.Context, tx pgx.Tx, partyType string, partyID uuid.UUID) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		ELSE false END`, partyType, partyID).Scan(&exists)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验订单对手失败", err)
	}
	if !exists {
		return apierror.Validation("订单参数不合法", map[string][]string{"partyId": {"对手不存在"}})
	}
	return nil
}

func writeAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, resource string,
	recordID uuid.UUID, label, actionType, actionName string, companyID uuid.UUID,
	changes map[string]audit.Change,
) error {
	if len(changes) == 0 {
		return nil
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: recordID, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入订单审计失败", err)
	}
	return nil
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "order_unique_order_no", Message: "订单号已存在"},
	{Code: "23505", Message: "订单数据已存在"},
	{Code: "23503", Message: "订单数据已被业务引用,不可删除"},
	{Code: "23514", Message: "订单参数不符合约束", Validation: true},
	{Code: "23502", Message: "订单参数不符合约束", Validation: true},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}

func notFound(spec sideSpec) error {
	return apierror.New(apierror.CodeNotFound, spec.label+"不存在")
}

func itemNotFound() error {
	return apierror.New(apierror.CodeNotFound, "订单条目不存在")
}

func materialNotFound() error {
	return apierror.New(apierror.CodeNotFound, "发料清单行不存在")
}

func byproductNotFound() error {
	return apierror.New(apierror.CodeNotFound, "副产物清单行不存在")
}
