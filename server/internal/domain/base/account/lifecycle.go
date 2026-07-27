package account

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const accountSource = ` FROM (
	SELECT a.id, a.code, a.name, a.direction, a.is_group, a.active, a.role,
	       a.parent_id, a.company_id, a.currency_id, a.inserted_at, a.updated_at,
	       p.name AS parent_name, c.name AS company_name, currency.name AS currency_name,
	       EXISTS(SELECT 1 FROM bas_account child WHERE child.parent_id = a.id) AS has_children
	FROM bas_account a
	LEFT JOIN bas_account p ON p.id = a.parent_id
	JOIN bas_company c ON c.id = a.company_id
	LEFT JOIN bas_currency currency ON currency.id = a.currency_id
) account`

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Account, error) {
	where, args, empty := filterbuild.AppendCompanyFilter(actor, ` WHERE id = $1`, []any{id}, "company_id")
	if empty {
		return Account{}, apierror.New(apierror.CodeNotFound, "会计科目不存在")
	}
	query := `SELECT id, code, name, direction, is_group, active, role,
		parent_id, company_id, currency_id, inserted_at, updated_at,
		parent_name, company_name, currency_name, has_children` + accountSource + where
	item, err := scanAccount(s.pool.QueryRow(ctx, query, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apierror.New(apierror.CodeNotFound, "会计科目不存在")
	}
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "读取会计科目失败", err)
	}
	return item, nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[Account]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "会计科目", Actor: actor,
		Source: accountSource,
		Select: `SELECT id, code, name, direction, is_group, active, role,
parent_id, company_id, currency_id, inserted_at, updated_at,
parent_name, company_name, currency_name, has_children`,
		DefaultOrder: ` ORDER BY code ASC, id ASC`,
		Tiebreaker:   `, id ASC`,
		Scan: func(rows pgx.Rows) (Account, error) {
			return scanAccount(rows)
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

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Account, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "更新会计科目失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := getAccountForUpdate(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apierror.New(apierror.CodeNotFound, "会计科目不存在")
	}
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "读取会计科目失败", err)
	}
	if !actor.CanAccessCompany(before.CompanyID) {
		return Account{}, apierror.New(apierror.CodeForbidden, "无权访问该公司")
	}
	if err := lockTree(ctx, tx, before.CompanyID); err != nil {
		return Account{}, err
	}
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.Direction != nil {
		after.Direction = *input.Direction
	}
	if input.IsGroup != nil {
		after.IsGroup = *input.IsGroup
	}
	if input.Active != nil {
		after.Active = *input.Active
	}
	if input.Role != nil {
		after.Role = *input.Role
	}
	if input.ParentID != nil {
		after.ParentID = *input.ParentID
	}
	if input.CurrencyID != nil {
		after.CurrencyID = *input.CurrencyID
	}
	create := CreateInput{
		Code: after.Code, Name: after.Name, Direction: after.Direction,
		IsGroup: after.IsGroup, Active: &after.Active, Role: after.Role,
		ParentID: after.ParentID, CompanyID: after.CompanyID, CurrencyID: after.CurrencyID,
	}
	normalizeCreate(&create)
	after.Name, after.Direction, after.Role = create.Name, create.Direction, create.Role
	if err := validateInput(create); err != nil {
		return Account{}, err
	}
	if err := validateRelations(ctx, tx, create); err != nil {
		return Account{}, err
	}
	if err := validateNoCycle(ctx, tx, id, after.ParentID); err != nil {
		return Account{}, err
	}
	_, err = tx.Exec(ctx, `
		UPDATE bas_account
		SET name = $2, direction = $3, is_group = $4, active = $5, role = $6,
		    parent_id = $7, currency_id = $8, updated_at = now()
		WHERE id = $1
	`, id, after.Name, strings.ToLower(after.Direction), after.IsGroup, after.Active,
		after.Role, after.ParentID, after.CurrencyID)
	if err != nil {
		return Account{}, mapWriteError("更新会计科目失败", err)
	}
	updated, err := getAccount(ctx, tx, id)
	if err != nil {
		return Account{}, apierror.Wrap(apierror.CodeInternal, "读取已更新会计科目失败", err)
	}
	changes := audit.Diff(snapshot(before), snapshot(updated), auditedFields)
	if len(changes) > 0 {
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "bas_account", RecordID: id, RecordLabel: updated.Name, CompanyID: &updated.CompanyID,
			ActionType: "update", ActionName: "update", Changes: changes,
		}); err != nil {
			return Account{}, apierror.Wrap(apierror.CodeInternal, "更新会计科目失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, mapWriteError("更新会计科目失败", err)
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除会计科目失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := getAccountForUpdate(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "会计科目不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取会计科目失败", err)
	}
	if !actor.CanAccessCompany(item.CompanyID) {
		return apierror.New(apierror.CodeForbidden, "无权访问该公司")
	}
	if err := lockTree(ctx, tx, item.CompanyID); err != nil {
		return err
	}
	var hasChildren bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_account WHERE parent_id = $1)`, id).Scan(&hasChildren); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查子科目失败", err)
	}
	if hasChildren {
		return apierror.New(apierror.CodeConflict, "存在子科目，不能删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bas_account WHERE id = $1`, id); err != nil {
		return mapWriteError("删除会计科目失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "bas_account", RecordID: id, RecordLabel: item.Name, CompanyID: &item.CompanyID,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除会计科目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("删除会计科目失败", err)
	}
	return nil
}

func validateNoCycle(ctx context.Context, tx pgx.Tx, id uuid.UUID, parentID *uuid.UUID) error {
	if parentID == nil {
		return nil
	}
	if *parentID == id {
		return apierror.Validation("会计科目参数不合法", map[string][]string{"parentId": {"不能选择自身或下级科目"}})
	}
	var cycle bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE descendants AS (
			SELECT id FROM bas_account WHERE parent_id = $1
			UNION ALL
			SELECT child.id
			FROM bas_account child
			JOIN descendants d ON child.parent_id = d.id
		)
		SELECT EXISTS(SELECT 1 FROM descendants WHERE id = $2)
	`, id, *parentID).Scan(&cycle)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验科目树失败", err)
	}
	if cycle {
		return apierror.Validation("会计科目参数不合法", map[string][]string{"parentId": {"不能选择自身或下级科目"}})
	}
	return nil
}

func getAccountForUpdate(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Account, error) {
	var item Account
	err := tx.QueryRow(ctx, `
		SELECT id, code, name, direction, is_group, active, role,
		       parent_id, company_id, currency_id, inserted_at, updated_at
		FROM bas_account WHERE id = $1 FOR UPDATE
	`, id).Scan(&item.ID, &item.Code, &item.Name, &item.Direction, &item.IsGroup, &item.Active,
		&item.Role, &item.ParentID, &item.CompanyID, &item.CurrencyID, &item.InsertedAt, &item.UpdatedAt)
	normalizeResult(&item)
	return item, err
}

func getAccount(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Account, error) {
	return scanAccount(tx.QueryRow(ctx, `SELECT id, code, name, direction, is_group, active, role,
		parent_id, company_id, currency_id, inserted_at, updated_at,
		parent_name, company_name, currency_name, has_children`+accountSource+` WHERE id = $1`, id))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAccount(row rowScanner) (Account, error) {
	var item Account
	var parentName, currencyName *string
	err := row.Scan(&item.ID, &item.Code, &item.Name, &item.Direction, &item.IsGroup, &item.Active,
		&item.Role, &item.ParentID, &item.CompanyID, &item.CurrencyID, &item.InsertedAt, &item.UpdatedAt,
		&parentName, &item.Company.Name, &currencyName, &item.HasChildren)
	if err != nil {
		return Account{}, err
	}
	item.Company.ID = item.CompanyID
	if item.ParentID != nil && parentName != nil {
		item.Parent = &Reference{ID: *item.ParentID, Name: *parentName}
	}
	if item.CurrencyID != nil && currencyName != nil {
		item.Currency = &Reference{ID: *item.CurrencyID, Name: *currencyName}
	}
	normalizeResult(&item)
	return item, nil
}
