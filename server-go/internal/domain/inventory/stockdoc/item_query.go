package stockdoc

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
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
	result, err := listexec.List(ctx, listexec.Spec[Item]{
		Pool: s.pool, Resource: ItemResourceMeta(), Label: "手工出入库单行", Actor: actor,
		Source: ` FROM inv_stock_doc_item`,
		Select: `SELECT id,idx,qty,base_qty,material_code,material_name,
material_spec,unit_name,remark,inserted_at,updated_at,stock_doc_id,company_id,
material_id,unit_id`,
		DefaultOrder: ` ORDER BY "idx" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Item, error) {
			var row dbgen.InvStockDocItem
			if err := rows.Scan(
				&row.ID, &row.Idx, &row.Qty, &row.BaseQty, &row.MaterialCode,
				&row.MaterialName, &row.MaterialSpec, &row.UnitName, &row.Remark,
				&row.InsertedAt, &row.UpdatedAt, &row.StockDocID, &row.CompanyID,
				&row.MaterialID, &row.UnitID,
			); err != nil {
				return Item{}, err
			}
			return itemFromRow(row), nil
		},
	}, listQuery(query))
	if err != nil {
		return ItemListResult{}, err
	}
	return ItemListResult{Count: result.Count, Results: result.Results}, nil
}
