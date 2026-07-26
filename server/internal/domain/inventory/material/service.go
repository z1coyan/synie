package material

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, numberer Numberer) *Service {
	return &Service{pool: pool, numberer: numberer}
}

const materialSource = ` FROM (
	SELECT m.id,m.code,m.name,m.spec,m.customer_part_no,m.is_customer_material,m.active,
	       m.inserted_at,m.updated_at,m.category_id,m.default_unit_id,m.customer_id,
	       category.code AS category_code,category.name AS category_name,
	       unit.name AS unit_name,unit.symbol AS unit_symbol,
	       customer.code AS customer_code,customer.name AS customer_name
	FROM inv_material m
	JOIN inv_material_category category ON category.id=m.category_id
	JOIN bas_unit unit ON unit.id=m.default_unit_id
	LEFT JOIN sal_customers customer ON customer.id=m.customer_id
) material`

const materialSelect = `SELECT id,code,name,spec,customer_part_no,is_customer_material,active,
	inserted_at,updated_at,category_id,default_unit_id,customer_id,
	category_code,category_name,unit_name,unit_symbol,customer_code,customer_name`

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Material, error) {
	item, err := scanMaterial(s.pool.QueryRow(ctx, materialSelect+materialSource+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Material{}, apierror.New(apierror.CodeNotFound, "物料不存在")
	}
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取物料失败", err)
	}
	return item, nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
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
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY code ASC,id ASC`
	} else {
		order += `,id ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询物料失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+materialSource+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计物料失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, materialSelect+materialSource+built.Where+order+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询物料失败", err)
	}
	defer rows.Close()
	result.Results = make([]Material, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanMaterial(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取物料结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历物料结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成物料查询失败", err)
	}
	return result, nil
}

func getMaterial(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Material, error) {
	return scanMaterial(tx.QueryRow(ctx, materialSelect+materialSource+` WHERE id=$1`, id))
}

type scanner interface{ Scan(...any) error }

func scanMaterial(row scanner) (Material, error) {
	var item Material
	var categoryCode, unitSymbol string
	var customerCode, customerName *string
	err := row.Scan(
		&item.ID, &item.Code, &item.Name, &item.Spec, &item.CustomerPartNo,
		&item.IsCustomerMaterial, &item.Active, &item.InsertedAt, &item.UpdatedAt,
		&item.CategoryID, &item.DefaultUnitID, &item.CustomerID,
		&categoryCode, &item.Category.Name, &item.DefaultUnit.Name, &unitSymbol,
		&customerCode, &customerName,
	)
	if err != nil {
		return Material{}, err
	}
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	item.Category.ID, item.Category.Code = item.CategoryID, &categoryCode
	item.DefaultUnit.ID, item.DefaultUnit.Symbol = item.DefaultUnitID, &unitSymbol
	if item.CustomerID != nil && customerName != nil {
		item.Customer = &Reference{ID: *item.CustomerID, Name: *customerName, Code: customerCode}
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
