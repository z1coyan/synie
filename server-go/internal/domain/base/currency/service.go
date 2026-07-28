package currency

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

type Service struct {
	pool    *pgxpool.Pool
	queries *dbgen.Queries
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, queries: dbgen.New(pool)}
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Currency, error) {
	row, err := s.queries.GetCurrency(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Currency{}, apierror.New(apierror.CodeNotFound, "货币不存在")
	}
	if err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "读取货币失败", err)
	}
	return currencyFromGet(row), nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[Currency]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "货币",
		Source:       ` FROM bas_currency`,
		Select:       `SELECT id, name, iso_code, symbol, active, inserted_at, updated_at`,
		DefaultOrder: ` ORDER BY "iso_code" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Currency, error) {
			var item Currency
			if err := rows.Scan(&item.ID, &item.Name, &item.ISOCode, &item.Symbol, &item.Active, &item.InsertedAt, &item.UpdatedAt); err != nil {
				return Currency{}, err
			}
			item.InsertedAt = item.InsertedAt.UTC()
			item.UpdatedAt = item.UpdatedAt.UTC()
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

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Currency, error) {
	if err := validateCreate(&input); err != nil {
		return Currency{}, err
	}
	active := true
	if input.Active != nil {
		active = *input.Active
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "创建货币失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).CreateCurrency(ctx, dbgen.CreateCurrencyParams{
		Name: input.Name, IsoCode: input.ISOCode, Symbol: pgconv.Text(input.Symbol), Active: active,
	})
	if err != nil {
		return Currency{}, mapWriteError("创建货币失败", err)
	}
	item := currencyFromCreate(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_currency", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "创建货币失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Currency{}, mapWriteError("创建货币失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Currency, error) {
	if err := validateUpdate(&input); err != nil {
		return Currency{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "更新货币失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	locked, err := queries.LockCurrency(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Currency{}, apierror.New(apierror.CodeNotFound, "货币不存在")
	}
	if err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "更新货币失败", err)
	}
	before := currencyFromLock(locked)
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.Symbol.Set {
		after.Symbol = input.Symbol.Value
	}
	if input.Active != nil {
		after.Active = *input.Active
	}
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Currency{}, apierror.Wrap(apierror.CodeInternal, "更新货币失败", err)
		}
		return before, nil
	}
	if before.Active && !after.Active {
		referenced, err := queries.CurrencyIsCompanyBase(ctx, id)
		if err != nil {
			return Currency{}, apierror.Wrap(apierror.CodeInternal, "校验货币引用失败", err)
		}
		if referenced {
			return Currency{}, apierror.Validation("币种参数不合法", map[string][]string{
				"active": {"已被公司引用为本币,不可停用"},
			})
		}
	}
	updated, err := queries.UpdateCurrency(ctx, dbgen.UpdateCurrencyParams{
		ID: id, Name: after.Name, Symbol: pgconv.Text(after.Symbol), Active: after.Active,
	})
	if err != nil {
		return Currency{}, mapWriteError("更新货币失败", err)
	}
	item := currencyFromUpdate(updated)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_currency", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Currency{}, apierror.Wrap(apierror.CodeInternal, "更新货币失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Currency{}, mapWriteError("更新货币失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除货币失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	locked, err := queries.LockCurrency(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "货币不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除货币失败", err)
	}
	item := currencyFromLock(locked)
	if _, err := queries.DeleteCurrency(ctx, id); err != nil {
		return mapWriteError("删除货币失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_currency", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除货币失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("删除货币失败", err)
	}
	return nil
}

func snapshot(item Currency) map[string]any {
	return map[string]any{
		"name": item.Name, "iso_code": item.ISOCode, "symbol": item.Symbol, "active": item.Active,
	}
}

func currencyFromGet(row dbgen.GetCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: pgconv.TextPtr(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromLock(row dbgen.LockCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: pgconv.TextPtr(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromCreate(row dbgen.CreateCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: pgconv.TextPtr(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromUpdate(row dbgen.UpdateCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: pgconv.TextPtr(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "ISO 编码已存在"},
	{Code: "23503", Message: "货币已被业务数据引用,不可删除"},
	{Constraint: "duplicate key", Message: "ISO 编码已存在"},
}

func mapWriteError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
