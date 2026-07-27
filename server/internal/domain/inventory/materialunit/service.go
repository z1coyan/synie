package materialunit

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

const materialUnitSource = ` FROM (
	SELECT mu.id,mu.factor,mu.inserted_at,mu.updated_at,mu.material_id,mu.unit_id,
	       m.name AS material_name,u.name AS unit_name,u.symbol AS unit_symbol
	FROM inv_material_unit mu
	JOIN inv_material m ON m.id=mu.material_id
	JOIN bas_unit u ON u.id=mu.unit_id
) material_unit`

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (MaterialUnit, error) {
	item, err := scanMaterialUnit(s.pool.QueryRow(ctx, materialUnitSelect+materialUnitSource+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return MaterialUnit{}, apierror.New(apierror.CodeNotFound, "物料单位转换不存在")
	}
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位转换失败", err)
	}
	return item, nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[MaterialUnit]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "物料单位转换",
		Source:       materialUnitSource,
		Select:       materialUnitSelect,
		DefaultOrder: ` ORDER BY inserted_at ASC,id ASC`,
		Tiebreaker:   `,id ASC`,
		Scan: func(rows pgx.Rows) (MaterialUnit, error) {
			return scanMaterialUnit(rows)
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

const materialUnitSelect = `SELECT id,factor,inserted_at,updated_at,material_id,unit_id,
	material_name,unit_name,unit_symbol`

func getMaterialUnit(ctx context.Context, tx pgx.Tx, id uuid.UUID) (MaterialUnit, error) {
	return scanMaterialUnit(tx.QueryRow(ctx, materialUnitSelect+materialUnitSource+` WHERE id=$1`, id))
}

type scanner interface{ Scan(...any) error }

func scanMaterialUnit(row scanner) (MaterialUnit, error) {
	var item MaterialUnit
	var factor decimal.Decimal
	var symbol string
	err := row.Scan(&item.ID, &factor, &item.InsertedAt, &item.UpdatedAt,
		&item.MaterialID, &item.UnitID, &item.Material.Name, &item.Unit.Name, &symbol)
	if err != nil {
		return MaterialUnit{}, err
	}
	item.Factor = factor.String()
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	item.Material.ID, item.Unit.ID, item.Unit.Symbol = item.MaterialID, item.UnitID, &symbol
	return item, nil
}
