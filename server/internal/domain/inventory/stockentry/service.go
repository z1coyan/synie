package stockentry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
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
	where, args := built.Where, append([]any(nil), built.Args...)
	bypass, companyIDs := actor.CompanyFilter()
	if !bypass {
		if len(companyIDs) == 0 {
			return ListResult{Results: []Entry{}}, nil
		}
		clause := fmt.Sprintf(`"company_id" = ANY($%d::uuid[])`, len(args)+1)
		args = append(args, companyIDs)
		if where == "" {
			where = " WHERE " + clause
		} else {
			where += " AND " + clause
		}
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "seq" ASC`
	} else {
		order += `, "seq" ASC`
	}
	const source = ` FROM inv_stock_entry`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询库存分录失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计库存分录失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,seq,quantity,posting_date,voucher_type,voucher_id,voucher_no,
		is_cancelled,remarks,inserted_at,company_id,warehouse_id,material_id,cancelled_at`+
		source+where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询库存分录失败", err)
	}
	defer rows.Close()
	result.Results = make([]Entry, 0, query.Limit)
	for rows.Next() {
		var item Entry
		var posting pgtype.Date
		var remarks pgtype.Text
		var inserted, cancelled pgtype.Timestamp
		if err := rows.Scan(
			&item.ID, &item.Seq, &item.Quantity, &posting, &item.VoucherType,
			&item.VoucherID, &item.VoucherNo, &item.IsCancelled, &remarks, &inserted,
			&item.CompanyID, &item.WarehouseID, &item.MaterialID, &cancelled,
		); err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取库存分录结果失败", err)
		}
		item.PostingDate = posting.Time
		item.Remarks = optionalText(remarks)
		item.InsertedAt = inserted.Time.UTC()
		item.CancelledAt = optionalTimestamp(cancelled)
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历库存分录结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成库存分录查询失败", err)
	}
	return result, nil
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
		IsCancelled: row.IsCancelled, CancelledAt: optionalTimestamp(row.CancelledAt),
		Remarks: optionalText(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		CompanyID: row.CompanyID, WarehouseID: row.WarehouseID, MaterialID: row.MaterialID,
	}
}

func optionalText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func optionalTimestamp(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}
