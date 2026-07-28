package stocktransfer

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

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Transfer]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "手工调拨单", Actor: actor,
		Source: ` FROM inv_stock_transfer`,
		Select: `SELECT id,doc_no,doc_date,summary,remarks,status,shipped_at,
received_at,inserted_at,updated_at,company_id,from_warehouse_id,to_warehouse_id,
transit_warehouse_id,created_by_id,shipped_by_id,received_by_id`,
		DefaultOrder: ` ORDER BY "doc_no" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Transfer, error) {
			return scanTransfer(rows)
		},
	}, listQuery(query))
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Count: result.Count, Results: result.Results}, nil
}

func listQuery(query ListQuery) listexec.Query {
	return listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter}
}

// QueryItems is the Grid-facing item query. ListItems remains the aggregate
// convenience method for loading all rows of a known transfer.
func (s *Service) QueryItems(ctx context.Context, actor *authz.Actor, query ListQuery) (ItemListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ItemListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Item]{
		Pool: s.pool, Resource: ItemResourceMeta(), Label: "手工调拨单行", Actor: actor,
		Source: ` FROM inv_stock_transfer_item`,
		Select: `SELECT id,idx,qty,base_qty,received_qty,material_code,
material_name,material_spec,unit_name,remark,inserted_at,updated_at,
stock_transfer_id,company_id,material_id,unit_id`,
		DefaultOrder: ` ORDER BY "idx" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Item, error) {
			return scanItem(rows)
		},
	}, listQuery(query))
	if err != nil {
		return ItemListResult{}, err
	}
	return ItemListResult{Count: result.Count, Results: result.Results}, nil
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
