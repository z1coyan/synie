package warehouse

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

const warehouseSource = ` FROM (
	SELECT w.id,w.name,w.is_leaf,w.active,w.is_outsourced,w.party_type,w.party_id,
	       w.allow_negative,w.inserted_at,w.updated_at,w.company_id,w.parent_id,w.account_id,
	       company.code AS company_code,company.name AS company_name,
	       parent.name AS parent_name,account.code AS account_code,account.name AS account_name,
	       EXISTS(SELECT 1 FROM inv_warehouse child WHERE child.parent_id=w.id) AS has_children
	FROM inv_warehouse w
	JOIN bas_company company ON company.id=w.company_id
	LEFT JOIN inv_warehouse parent ON parent.id=w.parent_id
	LEFT JOIN bas_account account ON account.id=w.account_id
) warehouse`

const warehouseSelect = `SELECT id,name,is_leaf,active,is_outsourced,party_type,party_id,
	allow_negative,inserted_at,updated_at,company_id,parent_id,account_id,
	company_code,company_name,parent_name,account_code,account_name,has_children`

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Warehouse, error) {
	if actor == nil {
		return Warehouse{}, apierror.New(apierror.CodeForbidden, "无权访问仓库")
	}
	query := warehouseSelect + warehouseSource + ` WHERE id=$1`
	args := []any{id}
	bypass, companyIDs := actor.CompanyFilter()
	if !bypass {
		query += ` AND company_id=ANY($2)`
		args = append(args, companyIDs)
	}
	item, err := scanWarehouse(s.pool.QueryRow(ctx, query, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return Warehouse{}, apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	return item, nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	return s.list(ctx, actor, query, nil)
}

func (s *Service) ListOutsourced(
	ctx context.Context,
	actor *authz.Actor,
	partyType string,
	partyID uuid.UUID,
	query ListQuery,
) (ListResult, error) {
	normalized := strings.ToLower(strings.TrimSpace(partyType))
	if normalized != "supplier" && normalized != "company" {
		return ListResult{}, apierror.Validation("外协仓查询参数不合法", map[string][]string{
			"partyType": {"只能为 SUPPLIER 或 COMPANY"},
		})
	}
	if partyID == uuid.Nil {
		return ListResult{}, apierror.Validation("外协仓查询参数不合法", map[string][]string{
			"partyId": {"不能为空"},
		})
	}
	return s.list(ctx, actor, query, &warehouseParty{partyType: normalized, partyID: partyID})
}

type warehouseParty struct {
	partyType string
	partyID   uuid.UUID
}

func (s *Service) list(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
	outsourced *warehouseParty,
) (ListResult, error) {
	if actor == nil {
		return ListResult{}, apierror.New(apierror.CodeForbidden, "无权访问仓库")
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if err := validatePage(query.Limit, query.Offset); err != nil {
		return ListResult{}, err
	}
	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	where := built.Where
	args := append([]any(nil), built.Args...)
	if outsourced != nil {
		where = appendWarehousePredicate(where, fmt.Sprintf(
			`is_outsourced=true AND party_type=$%d AND party_id=$%d`,
			len(args)+1, len(args)+2,
		))
		args = append(args, outsourced.partyType, outsourced.partyID)
	}
	bypass, companyIDs := actor.CompanyFilter()
	if !bypass {
		where = appendWarehousePredicate(where, fmt.Sprintf(`company_id=ANY($%d)`, len(args)+1))
		args = append(args, companyIDs)
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY name ASC,id ASC`
	} else {
		order += `,id ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询仓库失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+warehouseSource+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计仓库失败", err)
	}
	limitAt := len(args) + 1
	listArgs := append(append([]any(nil), args...), query.Limit, query.Offset)
	rows, err := tx.Query(ctx, warehouseSelect+warehouseSource+where+order+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), listArgs...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询仓库失败", err)
	}
	defer rows.Close()
	result.Results = make([]Warehouse, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanWarehouse(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取仓库结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历仓库结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成仓库查询失败", err)
	}
	return result, nil
}

func appendWarehousePredicate(where, predicate string) string {
	if where == "" {
		return ` WHERE ` + predicate
	}
	return where + ` AND ` + predicate
}

func getWarehouse(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Warehouse, error) {
	return scanWarehouse(tx.QueryRow(ctx, warehouseSelect+warehouseSource+` WHERE id=$1`, id))
}

type scanner interface{ Scan(...any) error }

func scanWarehouse(row scanner) (Warehouse, error) {
	var item Warehouse
	var partyType pgtype.Text
	var companyCode string
	var parentName, accountCode, accountName *string
	err := row.Scan(
		&item.ID, &item.Name, &item.IsLeaf, &item.Active, &item.IsOutsourced,
		&partyType, &item.PartyID, &item.AllowNegative, &item.InsertedAt, &item.UpdatedAt,
		&item.CompanyID, &item.ParentID, &item.AccountID,
		&companyCode, &item.Company.Name, &parentName, &accountCode, &accountName,
		&item.HasChildren,
	)
	if err != nil {
		return Warehouse{}, err
	}
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	item.Company.ID, item.Company.Code = item.CompanyID, &companyCode
	if partyType.Valid {
		value := strings.ToUpper(partyType.String)
		item.PartyType = &value
	}
	if item.ParentID != nil && parentName != nil {
		item.Parent = &Reference{ID: *item.ParentID, Name: *parentName}
	}
	if item.AccountID != nil && accountName != nil {
		item.Account = &Reference{ID: *item.AccountID, Name: *accountName, Code: accountCode}
	}
	return item, nil
}

func validatePage(limit, offset int) error {
	fields := map[string][]string{}
	if limit < 1 || limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) > 0 {
		return apierror.Validation("分页参数不合法", fields)
	}
	return nil
}
