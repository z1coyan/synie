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
	"github.com/z1coyan/synie/server/internal/db/listexec"
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
	where, args, empty := filterbuild.AppendCompanyFilter(actor, ` WHERE id=$1`, []any{id}, "company_id")
	if empty {
		return Warehouse{}, apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	query := warehouseSelect + warehouseSource + where
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
	result, err := listexec.List(ctx, listexec.Spec[Warehouse]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "仓库", Actor: actor,
		Source:       warehouseSource,
		Select:       warehouseSelect,
		DefaultOrder: ` ORDER BY name ASC,id ASC`,
		Tiebreaker:   `,id ASC`,
		AdjustWhere: func(where string, args []any) (string, []any) {
			if outsourced == nil {
				return where, args
			}
			where = appendWarehousePredicate(where, fmt.Sprintf(
				`is_outsourced=true AND party_type=$%d AND party_id=$%d`,
				len(args)+1, len(args)+2,
			))
			return where, append(args, outsourced.partyType, outsourced.partyID)
		},
		Scan: func(rows pgx.Rows) (Warehouse, error) {
			return scanWarehouse(rows)
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
