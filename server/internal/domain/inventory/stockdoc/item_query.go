package stockdoc

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type ItemListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

func (s *Service) QueryItems(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (ItemListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ItemListResult{}, err
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return ItemListResult{}, apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	built, err := filterbuild.Build(ItemResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ItemListResult{}, err
	}
	where, args := built.Where, append([]any(nil), built.Args...)
	where, args, empty := filterbuild.AppendCompanyFilter(actor, where, args, "company_id")
	if empty {
		return ItemListResult{Results: []Item{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "idx" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	const source = ` FROM inv_stock_doc_item`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工出入库单行失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "统计手工出入库单行失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,idx,qty,base_qty,material_code,material_name,
		material_spec,unit_name,remark,inserted_at,updated_at,stock_doc_id,company_id,
		material_id,unit_id`+source+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询手工出入库单行失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		var row dbgen.InvStockDocItem
		if err := rows.Scan(
			&row.ID, &row.Idx, &row.Qty, &row.BaseQty, &row.MaterialCode,
			&row.MaterialName, &row.MaterialSpec, &row.UnitName, &row.Remark,
			&row.InsertedAt, &row.UpdatedAt, &row.StockDocID, &row.CompanyID,
			&row.MaterialID, &row.UnitID,
		); err != nil {
			return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行结果失败", err)
		}
		result.Results = append(result.Results, itemFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历手工出入库单行结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "完成手工出入库单行查询失败", err)
	}
	return result, nil
}
