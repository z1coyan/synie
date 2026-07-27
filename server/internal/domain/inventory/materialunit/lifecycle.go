package materialunit

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (MaterialUnit, error) {
	factor, err := validateFactor(input.Factor)
	if err != nil {
		return MaterialUnit{}, err
	}
	if input.MaterialID == uuid.Nil || input.UnitID == uuid.Nil {
		return MaterialUnit{}, apierror.Validation("物料单位转换参数不合法", map[string][]string{
			"materialId": {"不能为空"}, "unitId": {"不能为空"},
		})
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "创建物料单位转换失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateUnitChoice(ctx, tx, input.MaterialID, input.UnitID); err != nil {
		return MaterialUnit{}, err
	}
	row, err := dbgen.New(tx).CreateMaterialUnit(ctx, dbgen.CreateMaterialUnitParams{
		MaterialID: input.MaterialID, UnitID: input.UnitID, Factor: factor,
	})
	if err != nil {
		return MaterialUnit{}, writeError("创建物料单位转换失败", err)
	}
	item, err := getMaterialUnit(ctx, tx, row.ID)
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "读取新物料单位转换失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_unit", RecordID: item.ID, RecordLabel: item.Unit.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "创建物料单位转换失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MaterialUnit{}, writeError("创建物料单位转换失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (MaterialUnit, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "更新物料单位转换失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).LockMaterialUnit(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return MaterialUnit{}, apierror.New(apierror.CodeNotFound, "物料单位转换不存在")
	}
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位转换失败", err)
	}
	before, err := getMaterialUnit(ctx, tx, id)
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位转换失败", err)
	}
	unitID, factor := row.UnitID, row.Factor
	if input.UnitID != nil {
		unitID = *input.UnitID
	}
	if input.Factor != nil {
		factor, err = validateFactor(*input.Factor)
		if err != nil {
			return MaterialUnit{}, err
		}
	}
	if unitID == uuid.Nil {
		return MaterialUnit{}, apierror.Validation("物料单位转换参数不合法", map[string][]string{"unitId": {"不能为空"}})
	}
	if err := validateUnitChoice(ctx, tx, row.MaterialID, unitID); err != nil {
		return MaterialUnit{}, err
	}
	if unitID == row.UnitID && factor.Equal(row.Factor) {
		if err := tx.Commit(ctx); err != nil {
			return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "更新物料单位转换失败", err)
		}
		return before, nil
	}
	if _, err := dbgen.New(tx).UpdateMaterialUnit(ctx, dbgen.UpdateMaterialUnitParams{
		ID: id, UnitID: unitID, Factor: factor,
	}); err != nil {
		return MaterialUnit{}, writeError("更新物料单位转换失败", err)
	}
	updated, err := getMaterialUnit(ctx, tx, id)
	if err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "读取已更新物料单位转换失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_unit", RecordID: id, RecordLabel: updated.Unit.Name,
		ActionType: "update", ActionName: "update",
		Changes: audit.Diff(snapshot(before), snapshot(updated), auditedFields),
	}); err != nil {
		return MaterialUnit{}, apierror.Wrap(apierror.CodeInternal, "更新物料单位转换失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MaterialUnit{}, writeError("更新物料单位转换失败", err)
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料单位转换失败", err)
	}
	defer tx.Rollback(ctx)
	if _, err := dbgen.New(tx).LockMaterialUnit(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "物料单位转换不存在")
	} else if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取物料单位转换失败", err)
	}
	item, err := getMaterialUnit(ctx, tx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取物料单位转换失败", err)
	}
	if err := dbgen.New(tx).DeleteMaterialUnit(ctx, id); err != nil {
		return writeError("删除物料单位转换失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_unit", RecordID: id, RecordLabel: item.Unit.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料单位转换失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除物料单位转换失败", err)
	}
	return nil
}

func validateFactor(raw string) (decimal.Decimal, error) {
	value, err := decimal.NewFromString(raw)
	if err != nil || !value.GreaterThan(decimal.Zero) {
		return decimal.Decimal{}, apierror.Validation("物料单位转换参数不合法", map[string][]string{
			"factor": {"换算系数必须大于 0"},
		})
	}
	return value, nil
}

func validateUnitChoice(ctx context.Context, tx pgx.Tx, materialID, unitID uuid.UUID) error {
	defaultUnitID, err := dbgen.New(tx).MaterialDefaultUnitID(ctx, materialID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("物料单位转换参数不合法", map[string][]string{"materialId": {"物料不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验物料默认单位失败", err)
	}
	if defaultUnitID == unitID {
		return apierror.Validation("物料单位转换参数不合法", map[string][]string{"unitId": {"转换单位不能与默认单位相同"}})
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_unit WHERE id=$1)`, unitID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验转换单位失败", err)
	}
	if !exists {
		return apierror.Validation("物料单位转换参数不合法", map[string][]string{"unitId": {"单位不存在"}})
	}
	return nil
}

func snapshot(item MaterialUnit) map[string]any {
	return map[string]any{"factor": item.Factor, "material_id": item.MaterialID, "unit_id": item.UnitID}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "inv_material_unit_unique_material_unit_index", Message: "该单位已有转换行"},
	{Code: "23505", Message: "物料单位转换已存在"},
	{Code: "23503", Message: "物料或单位不存在或转换行已被引用"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
