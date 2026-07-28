package material

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/listexec"
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
	result, err := listexec.List(ctx, listexec.Spec[Material]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "物料",
		Source:       materialSource,
		Select:       materialSelect,
		DefaultOrder: ` ORDER BY code ASC,id ASC`,
		Tiebreaker:   `,id ASC`,
		Scan: func(rows pgx.Rows) (Material, error) {
			return scanMaterial(rows)
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
