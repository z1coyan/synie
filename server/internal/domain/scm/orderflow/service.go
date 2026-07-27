package orderflow

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var sourceReadPermissions = []string{
	"purchase.receipt:read",
	"purchase.outsourced_issue:read",
	"purchase.outsourced_receipt:read",
	"sales.delivery:read",
}

var flowPrefixes = map[string]struct{}{
	"purchase_receipt":   {},
	"outsourced_issue":   {},
	"outsourced_receipt": {},
	"sales_delivery":     {},
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id string) (Item, error) {
	if err := requireRead(actor); err != nil {
		return Item{}, err
	}
	if !validFlowID(id) {
		return Item{}, apierror.Validation(
			"订单收发货历史行参数不合法", map[string][]string{"id": {"格式不合法"}},
		)
	}
	where, args := scopedWhere(actor, ` WHERE id=$1`, []any{id})
	item, err := scanOne(s.pool.QueryRow(ctx, selectColumns+where, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, notFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取订单收发货历史行失败", err)
	}
	return item, nil
}

func (s *Service) List(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (ListResult, error) {
	if err := requireRead(actor); err != nil {
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
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	where, args := built.Where, built.Args
	if query.OrderID != nil {
		where, args = appendWhere(where, args, `"order_id"`)
		args = append(args, *query.OrderID)
	}
	if query.OrderItemID != nil {
		where, args = appendWhere(where, args, `"order_item_id"`)
		args = append(args, *query.OrderItemID)
	}
	where, args = scopedWhere(actor, where, args)
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "voucher_date" DESC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单收发货历史失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM scm_order_flow_item`+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计订单收发货历史失败", err)
	}
	pageArgs := append([]any(nil), args...)
	limitArg := len(pageArgs) + 1
	pageArgs = append(pageArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, selectColumns+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, limitArg+1), pageArgs...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单收发货历史失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanOne(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取订单收发货历史结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历订单收发货历史结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成订单收发货历史查询失败", err)
	}
	return result, nil
}

func CanRead(actor *authz.Actor) bool {
	for _, permission := range sourceReadPermissions {
		if actor != nil && actor.HasPermission(permission) {
			return true
		}
	}
	return false
}

func requireRead(actor *authz.Actor) error {
	if CanRead(actor) {
		return nil
	}
	return apierror.New(apierror.CodeForbidden, "无权限读取订单收发货历史")
}

func validFlowID(id string) bool {
	prefix, rawID, ok := strings.Cut(id, ":")
	if !ok {
		return false
	}
	if _, ok := flowPrefixes[prefix]; !ok {
		return false
	}
	_, err := uuid.Parse(rawID)
	return err == nil
}

func appendWhere(where string, args []any, column string) (string, []any) {
	clause := fmt.Sprintf(`%s=$%d`, column, len(args)+1)
	if where == "" {
		return " WHERE " + clause, args
	}
	return where + " AND " + clause, args
}

func scopedWhere(actor *authz.Actor, where string, args []any) (string, []any) {
	return filterbuild.ApplyCompanyFilter(actor, where, args, "company_id")
}

const selectColumns = `SELECT id,flow_type,voucher_no,voucher_date,status,company_id,
	order_id,order_item_id,material_code,material_name,material_spec,customer_part_no,
	unit_name,qty FROM scm_order_flow_item`

type rowScanner interface{ Scan(...any) error }

func scanOne(row rowScanner) (Item, error) {
	var item Item
	var voucherDate pgtype.Date
	var materialSpec, customerPartNo pgtype.Text
	err := row.Scan(&item.ID, &item.FlowType, &item.VoucherNo, &voucherDate, &item.Status,
		&item.CompanyID, &item.OrderID, &item.OrderItemID, &item.MaterialCode,
		&item.MaterialName, &materialSpec, &customerPartNo, &item.UnitName, &item.Qty)
	if err != nil {
		return Item{}, err
	}
	item.FlowType = strings.ToUpper(item.FlowType)
	item.Status = strings.ToUpper(item.Status)
	item.VoucherDate = voucherDate.Time
	item.MaterialSpec = pgconv.TextPtr(materialSpec)
	item.CustomerPartNo = pgconv.TextPtr(customerPartNo)
	return item, nil
}

func notFound() error {
	return apierror.New(apierror.CodeNotFound, "订单收发货历史行不存在")
}
