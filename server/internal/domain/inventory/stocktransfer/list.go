package stocktransfer

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

type ItemListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	built, err := buildList(ResourceMeta(), query)
	if err != nil {
		return ListResult{}, err
	}
	where, args, empty := applyCompanyScope(actor, built.Where, built.Args)
	if empty {
		return ListResult{Results: []Transfer{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "doc_no" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	const source = ` FROM inv_stock_transfer`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工调拨单失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计手工调拨单失败", err)
	}
	rows, err := queryPage(ctx, tx, `SELECT id,doc_no,doc_date,summary,remarks,status,shipped_at,
		received_at,inserted_at,updated_at,company_id,from_warehouse_id,to_warehouse_id,
		transit_warehouse_id,created_by_id,shipped_by_id,received_by_id`+
		source+where+order, args, query)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工调拨单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Transfer, 0, query.Limit)
	for rows.Next() {
		item, err := scanTransfer(rows)
		if err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单结果失败", err)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历手工调拨单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成手工调拨单查询失败", err)
	}
	return result, nil
}

// QueryItems is the Grid-facing item query. ListItems remains the aggregate
// convenience method for loading all rows of a known transfer.
func (s *Service) QueryItems(ctx context.Context, actor *authz.Actor, query ListQuery) (ItemListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ItemListResult{}, err
	}
	built, err := buildList(ItemResourceMeta(), query)
	if err != nil {
		return ItemListResult{}, err
	}
	where, args, empty := applyCompanyScope(actor, built.Where, built.Args)
	if empty {
		return ItemListResult{Results: []Item{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "idx" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	const source = ` FROM inv_stock_transfer_item`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工调拨单行失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "统计手工调拨单行失败", err)
	}
	rows, err := queryPage(ctx, tx, `SELECT id,idx,qty,base_qty,received_qty,material_code,
		material_name,material_spec,unit_name,remark,inserted_at,updated_at,
		stock_transfer_id,company_id,material_id,unit_id`+source+where+order, args, query)
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工调拨单行失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "读取手工调拨单行结果失败", err)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历手工调拨单行结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "完成手工调拨单行查询失败", err)
	}
	return result, nil
}

func buildList(resourceMeta meta.ResourceMeta, query ListQuery) (filterbuild.SQL, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return filterbuild.SQL{}, apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	return filterbuild.Build(resourceMeta, filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
}

func applyCompanyScope(actor *authz.Actor, where string, initial []any) (string, []any, bool) {
	args := append([]any(nil), initial...)
	return filterbuild.AppendCompanyFilter(actor, where, args, "company_id")
}

func queryPage(ctx context.Context, tx pgx.Tx, sql string, args []any, query ListQuery) (pgx.Rows, error) {
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	return tx.Query(ctx, sql+fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
}

type scanner interface{ Scan(...any) error }

func scanTransfer(row scanner) (Transfer, error) {
	var raw dbgen.InvStockTransfer
	if err := row.Scan(
		&raw.ID, &raw.DocNo, &raw.DocDate, &raw.Summary, &raw.Remarks, &raw.Status,
		&raw.ShippedAt, &raw.ReceivedAt, &raw.InsertedAt, &raw.UpdatedAt,
		&raw.CompanyID, &raw.FromWarehouseID, &raw.ToWarehouseID, &raw.TransitWarehouseID,
		&raw.CreatedByID, &raw.ShippedByID, &raw.ReceivedByID,
	); err != nil {
		return Transfer{}, err
	}
	return transferFromRow(raw), nil
}

func scanItem(row scanner) (Item, error) {
	var raw dbgen.InvStockTransferItem
	if err := row.Scan(
		&raw.ID, &raw.Idx, &raw.Qty, &raw.BaseQty, &raw.ReceivedQty,
		&raw.MaterialCode, &raw.MaterialName, &raw.MaterialSpec, &raw.UnitName,
		&raw.Remark, &raw.InsertedAt, &raw.UpdatedAt, &raw.StockTransferID,
		&raw.CompanyID, &raw.MaterialID, &raw.UnitID,
	); err != nil {
		return Item{}, err
	}
	return itemFromRow(raw), nil
}
