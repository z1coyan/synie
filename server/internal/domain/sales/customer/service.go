package customer

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

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Customer, error) {
	row, err := dbgen.New(s.pool).GetCustomer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Customer{}, apierror.New(apierror.CodeNotFound, "客户不存在")
	}
	if err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "读取客户失败", err)
	}
	return fromRow(row), nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[Customer]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "客户",
		Source:       ` FROM sal_customers`,
		Select:       `SELECT id,code,name,short_name,inserted_at,updated_at`,
		DefaultOrder: ` ORDER BY "code" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Customer, error) {
			var row dbgen.SalCustomer
			if err := rows.Scan(&row.ID, &row.Code, &row.Name, &row.ShortName, &row.InsertedAt, &row.UpdatedAt); err != nil {
				return Customer{}, err
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

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Customer, error) {
	code, name, shortName, err := normalize(input.Code, input.Name, input.ShortName)
	if err != nil {
		return Customer{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "创建客户失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).CreateCustomer(ctx, dbgen.CreateCustomerParams{
		Code: code, Name: name, ShortName: pgconv.Text(shortName),
	})
	if err != nil {
		return Customer{}, writeError("创建客户失败", err)
	}
	item := fromRow(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sal_customer", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "创建客户失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Customer{}, writeError("创建客户失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Customer, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "更新客户失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockCustomer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Customer{}, apierror.New(apierror.CodeNotFound, "客户不存在")
	}
	if err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "读取客户失败", err)
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
		return Customer{}, err
	}
	after := before
	after.Code, after.Name, after.ShortName = code, name, shortName
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Customer{}, apierror.Wrap(apierror.CodeInternal, "更新客户失败", err)
		}
		return before, nil
	}
	updated, err := queries.UpdateCustomer(ctx, dbgen.UpdateCustomerParams{
		ID: id, Code: code, Name: name, ShortName: pgconv.Text(shortName),
	})
	if err != nil {
		return Customer{}, writeError("更新客户失败", err)
	}
	item := fromRow(updated)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sal_customer", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Customer{}, apierror.Wrap(apierror.CodeInternal, "更新客户失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Customer{}, writeError("更新客户失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除客户失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockCustomer(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "客户不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取客户失败", err)
	}
	hasMaterials, err := queries.CustomerHasMaterials(ctx, &id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验客户引用失败", err)
	}
	if hasMaterials {
		return apierror.New(apierror.CodeConflict, "存在关联物料,不能删除")
	}
	item := fromRow(row)
	if _, err := queries.DeleteCustomer(ctx, id); err != nil {
		return writeError("删除客户失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "sal_customer", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除客户失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除客户失败", err)
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
		return "", "", nil, apierror.Validation("客户参数不合法", fields)
	}
	return code, name, shortName, nil
}

func snapshot(item Customer) map[string]any {
	return map[string]any{"code": item.Code, "name": item.Name, "short_name": item.ShortName}
}

func fromRow(row dbgen.SalCustomer) Customer {
	return Customer{
		ID: row.ID, Code: row.Code, Name: row.Name, ShortName: pgconv.TextPtr(row.ShortName),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "客户编号已存在"},
	{Code: "23503", Message: "客户已被业务数据引用,不可删除"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
