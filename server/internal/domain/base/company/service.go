package company

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Company, error) {
	row, err := dbgen.New(s.pool).GetCompany(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Company{}, apierror.New(apierror.CodeNotFound, "公司不存在")
	}
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "读取公司失败", err)
	}
	return fromGet(row), nil
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
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
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
	const source = ` FROM (
		SELECT c.id, c.code, c.name, c.short_name, c.parent_id, c.base_currency_id,
		       c.inserted_at, c.updated_at, p.name AS parent_name, currency.name AS base_currency_name
		FROM bas_company AS c
		LEFT JOIN bas_company AS p ON p.id = c.parent_id
		JOIN bas_currency AS currency ON currency.id = c.base_currency_id
	) AS company`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询公司失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计公司失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id, code, name, short_name, parent_id, base_currency_id,
		inserted_at, updated_at, parent_name, base_currency_name`+source+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询公司失败", err)
	}
	defer rows.Close()
	result.Results = make([]Company, 0, query.Limit)
	for rows.Next() {
		var item Company
		var parentName *string
		if err := rows.Scan(&item.ID, &item.Code, &item.Name, &item.ShortName, &item.ParentID, &item.BaseCurrencyID,
			&item.InsertedAt, &item.UpdatedAt, &parentName, &item.BaseCurrency.Name); err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取公司结果失败", err)
		}
		item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
		item.BaseCurrency.ID = item.BaseCurrencyID
		if item.ParentID != nil && parentName != nil {
			item.Parent = &Reference{ID: *item.ParentID, Name: *parentName}
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历公司结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成公司查询失败", err)
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Company, error) {
	if err := validateCreate(&input); err != nil {
		return Company{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "创建公司失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	if err := validateCurrency(ctx, q, input.BaseCurrencyID); err != nil {
		return Company{}, err
	}
	if err := validateParent(ctx, q, uuid.Nil, input.ParentID); err != nil {
		return Company{}, err
	}
	id, err := q.CreateCompany(ctx, dbgen.CreateCompanyParams{
		Code: input.Code, Name: input.Name, ShortName: input.ShortName,
		ParentID: input.ParentID, BaseCurrencyID: input.BaseCurrencyID,
	})
	if err != nil {
		return Company{}, mapWriteError("创建公司失败", err)
	}
	row, err := q.GetCompany(ctx, id)
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "读取新公司失败", err)
	}
	item := fromGet(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_company", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "创建公司失败", err)
	}
	if _, err := warehouse.SeedCompanyDefaults(ctx, tx, actor, item.ID, item.Code); err != nil {
		return Company{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Company{}, mapWriteError("创建公司失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Company, error) {
	if err := validateUpdate(&input); err != nil {
		return Company{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "更新公司失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockCompany(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Company{}, apierror.New(apierror.CodeNotFound, "公司不存在")
	}
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "更新公司失败", err)
	}
	before := fromLock(locked)
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.ShortName != nil {
		after.ShortName = *input.ShortName
	}
	if input.ParentID != nil {
		after.ParentID = *input.ParentID
	}
	if input.BaseCurrencyID != nil {
		after.BaseCurrencyID = *input.BaseCurrencyID
	}
	if err := validateCurrency(ctx, q, after.BaseCurrencyID); err != nil {
		return Company{}, err
	}
	if err := validateParent(ctx, q, id, after.ParentID); err != nil {
		return Company{}, err
	}
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		row, err := q.GetCompany(ctx, id)
		if err != nil {
			return Company{}, apierror.Wrap(apierror.CodeInternal, "读取公司失败", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return Company{}, apierror.Wrap(apierror.CodeInternal, "更新公司失败", err)
		}
		return fromGet(row), nil
	}
	if err := q.UpdateCompany(ctx, dbgen.UpdateCompanyParams{
		ID: id, Name: after.Name, ShortName: after.ShortName,
		ParentID: after.ParentID, BaseCurrencyID: after.BaseCurrencyID,
	}); err != nil {
		return Company{}, mapWriteError("更新公司失败", err)
	}
	row, err := q.GetCompany(ctx, id)
	if err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "读取已更新公司失败", err)
	}
	item := fromGet(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_company", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Company{}, apierror.Wrap(apierror.CodeInternal, "更新公司失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Company{}, mapWriteError("更新公司失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除公司失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockCompany(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "公司不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除公司失败", err)
	}
	item := fromLock(row)
	if _, err := q.DeleteCompany(ctx, id); err != nil {
		return mapWriteError("删除公司失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_company", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除公司失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("删除公司失败", err)
	}
	return nil
}

func validateCurrency(ctx context.Context, q *dbgen.Queries, id uuid.UUID) error {
	active, err := q.CurrencyIsActive(ctx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验本币失败", err)
	}
	if !active {
		return apierror.Validation("公司参数不合法", map[string][]string{"baseCurrencyId": {"币种不存在或未启用"}})
	}
	return nil
}

func validateParent(ctx context.Context, q *dbgen.Queries, companyID uuid.UUID, parentID *uuid.UUID) error {
	seen := map[uuid.UUID]struct{}{}
	current := parentID
	for current != nil {
		if *current == companyID && companyID != uuid.Nil {
			return apierror.Validation("公司参数不合法", map[string][]string{"parentId": {"上级公司不能是自身或其下级公司"}})
		}
		if _, ok := seen[*current]; ok {
			return apierror.Validation("公司参数不合法", map[string][]string{"parentId": {"公司层级存在循环"}})
		}
		seen[*current] = struct{}{}
		next, err := q.CompanyParentLink(ctx, *current)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("公司参数不合法", map[string][]string{"parentId": {"上级公司不存在"}})
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验公司层级失败", err)
		}
		current = next
	}
	return nil
}

func snapshot(item Company) map[string]any {
	return map[string]any{
		"code": item.Code, "name": item.Name, "short_name": item.ShortName,
		"parent_id": item.ParentID, "base_currency_id": item.BaseCurrencyID,
	}
}

func fromGet(row dbgen.GetCompanyRow) Company {
	item := Company{
		ID: row.ID, Code: row.Code, Name: row.Name, ShortName: row.ShortName,
		ParentID: row.ParentID, BaseCurrencyID: row.BaseCurrencyID,
		BaseCurrency: Reference{ID: row.BaseCurrencyID, Name: row.BaseCurrencyName},
		InsertedAt:   row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
	if row.ParentID != nil && row.ParentName.Valid {
		item.Parent = &Reference{ID: *row.ParentID, Name: row.ParentName.String}
	}
	return item
}

func fromLock(row dbgen.LockCompanyRow) Company {
	return Company{
		ID: row.ID, Code: row.Code, Name: row.Name, ShortName: row.ShortName,
		ParentID: row.ParentID, BaseCurrencyID: row.BaseCurrencyID,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func mapWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "公司编号已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "公司已被业务数据引用,不可删除", err)
		}
	}
	if strings.Contains(err.Error(), "duplicate key") {
		return apierror.Wrap(apierror.CodeConflict, "公司编号已存在", err)
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
