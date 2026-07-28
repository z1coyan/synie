package stockentry

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Entry, error) {
	if err := requireRead(actor); err != nil {
		return Entry{}, err
	}
	row, err := dbgen.New(s.pool).GetStockEntry(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, apierror.New(apierror.CodeNotFound, "库存分录不存在")
	}
	if err != nil {
		return Entry{}, apierror.Wrap(apierror.CodeInternal, "读取库存分录失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Entry{}, apierror.New(apierror.CodeNotFound, "库存分录不存在")
	}
	return fromRow(row), nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := requireRead(actor); err != nil {
		return ListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Entry]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "库存分录", Actor: actor,
		Source: ` FROM inv_stock_entry`,
		Select: `SELECT id,seq,quantity,posting_date,voucher_type,voucher_id,voucher_no,
is_cancelled,remarks,inserted_at,company_id,warehouse_id,material_id,cancelled_at`,
		DefaultOrder: ` ORDER BY "seq" ASC`,
		Tiebreaker:   `, "seq" ASC`,
		Scan: func(rows pgx.Rows) (Entry, error) {
			var item Entry
			var posting pgtype.Date
			var remarks pgtype.Text
			var inserted, cancelled pgtype.Timestamp
			if err := rows.Scan(
				&item.ID, &item.Seq, &item.Quantity, &posting, &item.VoucherType,
				&item.VoucherID, &item.VoucherNo, &item.IsCancelled, &remarks, &inserted,
				&item.CompanyID, &item.WarehouseID, &item.MaterialID, &cancelled,
			); err != nil {
				return Entry{}, err
			}
			item.PostingDate = posting.Time
			item.Remarks = pgconv.TextPtr(remarks)
			item.InsertedAt = inserted.Time.UTC()
			item.CancelledAt = pgconv.OptionalTime(cancelled)
			return item, nil
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

func (s *Service) Balance(
	ctx context.Context,
	actor *authz.Actor,
	query BalanceQuery,
) ([]stock.BalanceRow, error) {
	if err := requireRead(actor); err != nil {
		return nil, err
	}
	if !actor.CanAccessCompany(query.CompanyID) {
		return nil, apierror.New(apierror.CodeForbidden, "无权查看该公司数据")
	}
	asOf := time.Time{}
	if query.AsOf != nil {
		asOf = *query.AsOf
	}
	hideZero := true
	if query.HideZero != nil {
		hideZero = *query.HideZero
	}
	return stock.Balance(ctx, s.pool, stock.BalanceQuery{
		CompanyID: query.CompanyID, AsOf: asOf,
		WarehouseID: query.WarehouseID, MaterialID: query.MaterialID,
		HideZero: hideZero,
	})
}

func requireRead(actor *authz.Actor) error {
	if actor == nil || !actor.HasPermission("inv.stock_entry:read") {
		return apierror.New(apierror.CodeForbidden, "无权查看库存分录")
	}
	return nil
}

func fromRow(row dbgen.GetStockEntryRow) Entry {
	return Entry{
		ID: row.ID, Seq: row.Seq, Quantity: row.Quantity,
		PostingDate: row.PostingDate.Time, VoucherType: row.VoucherType,
		VoucherID: row.VoucherID, VoucherNo: row.VoucherNo,
		IsCancelled: row.IsCancelled, CancelledAt: pgconv.OptionalTime(row.CancelledAt),
		Remarks: pgconv.TextPtr(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		CompanyID: row.CompanyID, WarehouseID: row.WarehouseID, MaterialID: row.MaterialID,
	}
}
