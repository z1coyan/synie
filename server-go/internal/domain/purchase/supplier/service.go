package supplier

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

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

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Supplier, error) {
	row, err := dbgen.New(s.pool).GetSupplier(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Supplier{}, apierror.New(apierror.CodeNotFound, "供应商不存在")
	}
	if err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "读取供应商失败", err)
	}
	return fromRow(row), nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[Supplier]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "供应商",
		Source:       ` FROM pur_supplier`,
		Select:       `SELECT id,code,name,short_name,inserted_at,updated_at`,
		DefaultOrder: ` ORDER BY "code" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Supplier, error) {
			var row dbgen.PurSupplier
			if err := rows.Scan(&row.ID, &row.Code, &row.Name, &row.ShortName, &row.InsertedAt, &row.UpdatedAt); err != nil {
				return Supplier{}, err
			}
			return fromRow(row), nil
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

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Supplier, error) {
	code, name, shortName, err := normalize(input.Code, input.Name, input.ShortName)
	if err != nil {
		return Supplier{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "创建供应商失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).CreateSupplier(ctx, dbgen.CreateSupplierParams{
		Code: code, Name: name, ShortName: pgconv.Text(shortName),
	})
	if err != nil {
		return Supplier{}, writeError("创建供应商失败", err)
	}
	item := fromRow(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "pur_supplier", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "创建供应商失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Supplier{}, writeError("创建供应商失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Supplier, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "更新供应商失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockSupplier(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Supplier{}, apierror.New(apierror.CodeNotFound, "供应商不存在")
	}
	if err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "读取供应商失败", err)
	}
	before := fromRow(row)
	code, name, shortName := before.Code, before.Name, before.ShortName
	if input.Code != nil {
		code = *input.Code
	}
	if input.Name != nil {
		name = *input.Name
	}
	if input.ShortName.Set {
		shortName = input.ShortName.Value
	}
	code, name, shortName, err = normalize(code, name, shortName)
	if err != nil {
		return Supplier{}, err
	}
	after := before
	after.Code, after.Name, after.ShortName = code, name, shortName
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Supplier{}, apierror.Wrap(apierror.CodeInternal, "更新供应商失败", err)
		}
		return before, nil
	}
	updated, err := queries.UpdateSupplier(ctx, dbgen.UpdateSupplierParams{
		ID: id, Code: code, Name: name, ShortName: pgconv.Text(shortName),
	})
	if err != nil {
		return Supplier{}, writeError("更新供应商失败", err)
	}
	item := fromRow(updated)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "pur_supplier", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Supplier{}, apierror.Wrap(apierror.CodeInternal, "更新供应商失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Supplier{}, writeError("更新供应商失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除供应商失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockSupplier(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "供应商不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取供应商失败", err)
	}
	item := fromRow(row)
	if _, err := queries.DeleteSupplier(ctx, id); err != nil {
		return writeError("删除供应商失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "pur_supplier", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除供应商失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除供应商失败", err)
	}
	return nil
}

func normalize(code, name string, shortName *string) (string, string, *string, error) {
	code, name = strings.TrimSpace(code), strings.TrimSpace(name)
	fields := map[string][]string{}
	if code == "" || utf8.RuneCountInString(code) > 32 {
		fields["code"] = []string{"不能为空且最多 32 个字符"}
	}
	if name == "" || utf8.RuneCountInString(name) > 128 {
		fields["name"] = []string{"不能为空且最多 128 个字符"}
	}
	if shortName != nil {
		value := strings.TrimSpace(*shortName)
		if value == "" {
			shortName = nil
		} else {
			shortName = &value
		}
		if utf8.RuneCountInString(value) > 64 {
			fields["shortName"] = []string{"最多 64 个字符"}
		}
	}
	if len(fields) > 0 {
		return "", "", nil, apierror.Validation("供应商参数不合法", fields)
	}
	return code, name, shortName, nil
}

func snapshot(item Supplier) map[string]any {
	return map[string]any{"code": item.Code, "name": item.Name, "short_name": item.ShortName}
}

func fromRow(row dbgen.PurSupplier) Supplier {
	return Supplier{
		ID: row.ID, Code: row.Code, Name: row.Name, ShortName: pgconv.TextPtr(row.ShortName),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "供应商编号已存在"},
	{Code: "23503", Message: "供应商已被业务数据引用,不可删除"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
