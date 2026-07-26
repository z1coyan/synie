package materialunit

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
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
		order = ` ORDER BY inserted_at ASC,id ASC`
	} else {
		order += `,id ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询物料单位转换失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+materialUnitSource+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计物料单位转换失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, materialUnitSelect+materialUnitSource+built.Where+order+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询物料单位转换失败", err)
	}
	defer rows.Close()
	result.Results = make([]MaterialUnit, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanMaterialUnit(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位转换结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历物料单位转换结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成物料单位转换查询失败", err)
	}
	return result, nil
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
