package customer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

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
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "code" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询客户失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sal_customers`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计客户失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitArg := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,code,name,short_name,inserted_at,updated_at FROM sal_customers`+
		built.Where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, limitArg+1), args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询客户失败", err)
	}
	defer rows.Close()
	result.Results = make([]Customer, 0, query.Limit)
	for rows.Next() {
		var row dbgen.SalCustomer
		if err := rows.Scan(&row.ID, &row.Code, &row.Name, &row.ShortName, &row.InsertedAt, &row.UpdatedAt); err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取客户结果失败", err)
		}
		result.Results = append(result.Results, fromRow(row))
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历客户结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成客户查询失败", err)
	}
	return result, nil
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
		Code: code, Name: name, ShortName: toText(shortName),
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
		ID: id, Code: code, Name: name, ShortName: toText(shortName),
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
		ID: row.ID, Code: row.Code, Name: row.Name, ShortName: fromText(row.ShortName),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
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

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "客户编号已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "客户已被业务数据引用,不可删除", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
