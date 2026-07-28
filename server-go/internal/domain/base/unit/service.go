package unit

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Unit, error) {
	r, e := dbgen.New(s.pool).GetUnit(ctx, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return Unit{}, apierror.New(apierror.CodeNotFound, "计量单位不存在")
	}
	if e != nil {
		return Unit{}, apierror.Wrap(apierror.CodeInternal, "读取计量单位失败", e)
	}
	return fromRow(r.ID, r.UnitType, r.IsBase, r.Name, r.Symbol, r.Ratio, r.InsertedAt.Time, r.UpdatedAt.Time), nil
}
func (s *Service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[Unit]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "计量单位",
		Source:       ` FROM bas_unit`,
		Select:       `SELECT id,unit_type,is_base,name,symbol,ratio,inserted_at,updated_at`,
		DefaultOrder: ` ORDER BY "unit_type","name","id"`,
		Tiebreaker:   `, "id"`,
		RawTail:      true,
		Scan: func(rows pgx.Rows) (Unit, error) {
			var x Unit
			if err := rows.Scan(&x.ID, &x.UnitType, &x.IsBase, &x.Name, &x.Symbol, &x.Ratio, &x.InsertedAt, &x.UpdatedAt); err != nil {
				return Unit{}, err
			}
			x.UnitType = strings.ToUpper(x.UnitType)
			x.InsertedAt = x.InsertedAt.UTC()
			x.UpdatedAt = x.UpdatedAt.UTC()
			return x, nil
		},
	}, listexec.Query{Limit: q.Limit, Offset: q.Offset, Search: q.Search, Sort: q.Sort, Filter: q.Filter})
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Count: result.Count, Results: result.Results}, nil
}
func normalize(t, name, symbol, ratio string, isBase bool) (string, string, string, decimal.Decimal, error) {
	t = strings.ToLower(strings.TrimSpace(t))
	name = strings.TrimSpace(name)
	symbol = strings.TrimSpace(symbol)
	fields := map[string][]string{}
	switch t {
	case "length", "area", "weight", "quantity":
	default:
		fields["unitType"] = []string{"仅支持 LENGTH/AREA/WEIGHT/QUANTITY"}
	}
	if name == "" || utf8.RuneCountInString(name) > 32 {
		fields["name"] = []string{"不能为空且最多 32 个字符"}
	}
	if symbol == "" || utf8.RuneCountInString(symbol) > 16 {
		fields["symbol"] = []string{"不能为空且最多 16 个字符"}
	}
	d, e := decimal.NewFromString(strings.TrimSpace(ratio))
	if e != nil || !d.IsPositive() {
		fields["ratio"] = []string{"换算比例必须大于 0"}
	} else if isBase && !d.Equal(decimal.NewFromInt(1)) {
		fields["ratio"] = []string{"基准单位换算比例必须为 1"}
	}
	if len(fields) > 0 {
		return "", "", "", decimal.Zero, apierror.Validation("计量单位参数不合法", fields)
	}
	return t, name, symbol, d, nil
}
func (s *Service) Create(ctx context.Context, a *authz.Actor, in CreateInput) (Unit, error) {
	base := false
	if in.IsBase != nil {
		base = *in.IsBase
	}
	t, n, sy, ra, e := normalize(in.UnitType, in.Name, in.Symbol, in.Ratio, base)
	if e != nil {
		return Unit{}, e
	}
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return Unit{}, e
	}
	defer tx.Rollback(ctx)
	r, e := dbgen.New(tx).CreateUnit(ctx, dbgen.CreateUnitParams{UnitType: t, IsBase: base, Name: n, Symbol: sy, Ratio: ra})
	if e != nil {
		return Unit{}, writeErr(e)
	}
	x := fromRow(r.ID, r.UnitType, r.IsBase, r.Name, r.Symbol, r.Ratio, r.InsertedAt.Time, r.UpdatedAt.Time)
	if e = audit.Write(ctx, tx, a, audit.Entry{Resource: "bas_unit", RecordID: x.ID, RecordLabel: x.Name, ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(x), auditedFields)}); e != nil {
		return Unit{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Unit{}, writeErr(e)
	}
	return x, nil
}
func (s *Service) Update(ctx context.Context, a *authz.Actor, id uuid.UUID, in UpdateInput) (Unit, error) {
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return Unit{}, e
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	r, e := q.LockUnit(ctx, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return Unit{}, apierror.New(apierror.CodeNotFound, "计量单位不存在")
	}
	if e != nil {
		return Unit{}, e
	}
	before := fromRow(r.ID, r.UnitType, r.IsBase, r.Name, r.Symbol, r.Ratio, r.InsertedAt.Time, r.UpdatedAt.Time)
	t, n, sy, rs, base := r.UnitType, r.Name, r.Symbol, r.Ratio.String(), r.IsBase
	if in.UnitType != nil {
		t = *in.UnitType
	}
	if in.Name != nil {
		n = *in.Name
	}
	if in.Symbol != nil {
		sy = *in.Symbol
	}
	if in.Ratio != nil {
		rs = *in.Ratio
	}
	if in.IsBase != nil {
		base = *in.IsBase
	}
	t, n, sy, ra, e := normalize(t, n, sy, rs, base)
	if e != nil {
		return Unit{}, e
	}
	u, e := q.UpdateUnit(ctx, dbgen.UpdateUnitParams{ID: id, UnitType: t, IsBase: base, Name: n, Symbol: sy, Ratio: ra})
	if e != nil {
		return Unit{}, writeErr(e)
	}
	x := fromRow(u.ID, u.UnitType, u.IsBase, u.Name, u.Symbol, u.Ratio, u.InsertedAt.Time, u.UpdatedAt.Time)
	changes := audit.Diff(snapshot(before), snapshot(x), auditedFields)
	if len(changes) > 0 {
		if e = audit.Write(ctx, tx, a, audit.Entry{Resource: "bas_unit", RecordID: id, RecordLabel: x.Name, ActionType: "update", ActionName: "update", Changes: changes}); e != nil {
			return Unit{}, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return Unit{}, writeErr(e)
	}
	return x, nil
}
func (s *Service) Delete(ctx context.Context, a *authz.Actor, id uuid.UUID) error {
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	r, e := q.LockUnit(ctx, id)
	if errors.Is(e, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "计量单位不存在")
	}
	if e != nil {
		return e
	}
	x := fromRow(r.ID, r.UnitType, r.IsBase, r.Name, r.Symbol, r.Ratio, r.InsertedAt.Time, r.UpdatedAt.Time)
	if _, e = q.DeleteUnit(ctx, id); e != nil {
		return writeErr(e)
	}
	if e = audit.Write(ctx, tx, a, audit.Entry{Resource: "bas_unit", RecordID: id, RecordLabel: x.Name, ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(x), auditedFields)}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return writeErr(e)
	}
	return nil
}
func fromRow(id uuid.UUID, t string, b bool, n, s string, r decimal.Decimal, i, u interface{ UTC() time.Time }) Unit {
	return Unit{ID: id, UnitType: strings.ToUpper(t), IsBase: b, Name: n, Symbol: s, Ratio: r, InsertedAt: i.UTC(), UpdatedAt: u.UTC()}
}
func snapshot(x Unit) map[string]any {
	return map[string]any{"unit_type": strings.ToLower(x.UnitType), "is_base": x.IsBase, "name": x.Name, "symbol": x.Symbol, "ratio": x.Ratio.String()}
}
func writeErr(e error) error {
	return dberr.MapWrite(e, "保存计量单位失败",
		dberr.Mapping{Code: "23505", Constraint: "base_per_type", Message: "该类型已存在基准单位"},
		dberr.Mapping{Code: "23505", Message: "单位符号已存在"},
		dberr.Mapping{Code: "23503", Message: "计量单位已被业务数据引用,不可删除"},
	)
}
