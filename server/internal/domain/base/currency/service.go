package currency

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
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
		return ListResult{}, apierror.Validation("分页参数不合法", fields)
	}

	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "iso_code" ASC, "id" ASC`
	} else {
		orderBy += `, "id" ASC`
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询货币失败", err)
	}
	defer tx.Rollback(ctx)

	var count int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM bas_currency`+built.Where, built.Args...).Scan(&count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计货币失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitArg := len(args) + 1
	args = append(args, query.Limit)
	offsetArg := len(args) + 1
	args = append(args, query.Offset)
	statement := `SELECT id, name, iso_code, symbol, active, inserted_at, updated_at FROM bas_currency` +
		built.Where + orderBy + fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, offsetArg)
	rows, err := tx.Query(ctx, statement, args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询货币失败", err)
	}
	defer rows.Close()
	result := ListResult{Count: count, Results: make([]Currency, 0, query.Limit)}
	for rows.Next() {
		var item Currency
		if err := rows.Scan(&item.ID, &item.Name, &item.ISOCode, &item.Symbol, &item.Active, &item.InsertedAt, &item.UpdatedAt); err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取货币结果失败", err)
		}
		item.InsertedAt = item.InsertedAt.UTC()
		item.UpdatedAt = item.UpdatedAt.UTC()
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历货币结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成货币查询失败", err)
	}
	return result, nil
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
		Name: input.Name, IsoCode: input.ISOCode, Symbol: toText(input.Symbol), Active: active,
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
		ID: id, Name: after.Name, Symbol: toText(after.Symbol), Active: after.Active,
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

func toText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func fromText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func currencyFromGet(row dbgen.GetCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: fromText(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromLock(row dbgen.LockCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: fromText(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromCreate(row dbgen.CreateCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: fromText(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func currencyFromUpdate(row dbgen.UpdateCurrencyRow) Currency {
	return Currency{ID: row.ID, Name: row.Name, ISOCode: row.IsoCode, Symbol: fromText(row.Symbol), Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC()}
}

func mapWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "ISO 编码已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "货币已被业务数据引用,不可删除", err)
		}
	}
	if strings.Contains(err.Error(), "duplicate key") {
		return apierror.Wrap(apierror.CodeConflict, "ISO 编码已存在", err)
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
