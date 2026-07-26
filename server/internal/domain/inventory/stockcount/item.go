package stockcount

import (
	"context"
	"errors"
	"math/big"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type itemProjection struct {
	convertedCounted *decimal.Decimal
	bookQuantity     decimal.Decimal
	materialCode     string
	materialName     string
	materialSpec     *string
	unitName         string
}

func (s *Service) GetItem(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Item, error) {
	if err := require(actor, "read"); err != nil {
		return Item{}, err
	}
	row, err := dbgen.New(s.pool).GetStockCountItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Item{}, apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	return itemFromRow(row), nil
}

func (s *Service) ListItems(
	ctx context.Context,
	actor *authz.Actor,
	countID uuid.UUID,
) ([]Item, error) {
	if err := require(actor, "read"); err != nil {
		return nil, err
	}
	q := dbgen.New(s.pool)
	count, err := q.GetStockCount(ctx, countID)
	if errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && !actor.CanAccessCompany(count.CompanyID)) {
		return nil, apierror.New(apierror.CodeNotFound, "库存盘点单不存在")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单失败", err)
	}
	rows, err := q.ListStockCountItems(ctx, countID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	result := make([]Item, 0, len(rows))
	for _, row := range rows {
		result = append(result, itemFromRow(row))
	}
	return result, nil
}

func (s *Service) CreateItem(
	ctx context.Context,
	actor *authz.Actor,
	input CreateItemInput,
) (Item, error) {
	if err := require(actor, "create"); err != nil {
		return Item{}, err
	}
	if err := validateItemInput(input.MaterialID, input.UnitID, input.CountedQuantity, input.Remark); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建库存盘点单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	count, err := lockDraftCount(ctx, q, actor, input.CountID)
	if err != nil {
		return Item{}, err
	}
	item, err := createItemInTx(ctx, tx, actor, count, input)
	if err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建库存盘点单行失败", err)
	}
	return item, nil
}

func createItemInTx(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	count Count,
	input CreateItemInput,
) (Item, error) {
	if err := validateItemInput(input.MaterialID, input.UnitID, input.CountedQuantity, input.Remark); err != nil {
		return Item{}, err
	}
	q := dbgen.New(tx)
	projection, err := buildItemProjection(
		ctx, q, count.WarehouseID, input.MaterialID, input.UnitID, input.CountedQuantity,
	)
	if err != nil {
		return Item{}, err
	}
	row, err := q.CreateStockCountItem(ctx, dbgen.CreateStockCountItemParams{
		CountedQuantity:  numeric(input.CountedQuantity),
		ConvertedCounted: numeric(projection.convertedCounted),
		BookQuantity:     projection.bookQuantity, MaterialCode: projection.materialCode,
		MaterialName: projection.materialName, MaterialSpec: text(projection.materialSpec),
		UnitName: projection.unitName, Remark: text(input.Remark), CountID: count.ID,
		CompanyID: count.CompanyID, MaterialID: input.MaterialID, UnitID: input.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建库存盘点单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(itemSnapshot(item), itemAuditedFields)); err != nil {
		return Item{}, err
	}
	return item, nil
}

func createLoadedItemInTx(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	count Count,
	projection dbgen.ListStockCountLoadAllProjectionRow,
) (Item, error) {
	q := dbgen.New(tx)
	row, err := q.CreateStockCountItem(ctx, dbgen.CreateStockCountItemParams{
		CountedQuantity: pgtype.Numeric{}, ConvertedCounted: pgtype.Numeric{},
		BookQuantity: projection.BookQuantity, MaterialCode: projection.MaterialCode,
		MaterialName: projection.MaterialName, MaterialSpec: projection.MaterialSpec,
		UnitName: projection.UnitName, Remark: pgtype.Text{}, CountID: count.ID,
		CompanyID: count.CompanyID, MaterialID: projection.MaterialID,
		UnitID: projection.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建库存盘点单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(itemSnapshot(item), itemAuditedFields)); err != nil {
		return Item{}, err
	}
	return item, nil
}

func (s *Service) UpdateItem(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateItemInput,
) (Item, error) {
	if err := require(actor, "update"); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockCountItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	count, err := lockDraftCount(ctx, q, actor, current.CountID)
	if err != nil {
		return Item{}, err
	}
	locked, err := q.LockStockCountItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "锁定库存盘点单行失败", err)
	}
	before := itemFromRow(locked)
	after := before
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.CountedQuantity != nil {
		after.CountedQuantity = *input.CountedQuantity
	}
	if input.Remark != nil {
		after.Remark = *input.Remark
	}
	if err := validateItemInput(
		after.MaterialID, after.UnitID, after.CountedQuantity, after.Remark,
	); err != nil {
		return Item{}, err
	}
	projection, err := buildItemProjection(
		ctx, q, count.WarehouseID, after.MaterialID, after.UnitID,
		after.CountedQuantity,
	)
	if err != nil {
		return Item{}, err
	}
	after.ConvertedCounted = projection.convertedCounted
	after.BookQuantity = projection.bookQuantity
	after.MaterialCode = projection.materialCode
	after.MaterialName = projection.materialName
	after.MaterialSpec = projection.materialSpec
	after.UnitName = projection.unitName
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点单行失败", err)
		}
		return before, nil
	}
	row, err := q.UpdateStockCountItem(ctx, dbgen.UpdateStockCountItemParams{
		ID: id, CountedQuantity: numeric(after.CountedQuantity),
		ConvertedCounted: numeric(after.ConvertedCounted),
		BookQuantity:     after.BookQuantity, MaterialCode: after.MaterialCode,
		MaterialName: after.MaterialName, MaterialSpec: text(after.MaterialSpec),
		UnitName: after.UnitName, Remark: text(after.Remark),
		MaterialID: after.MaterialID, UnitID: after.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点单行失败", err)
	}
	return item, nil
}

func (s *Service) DeleteItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除库存盘点单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockCountItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取库存盘点单行失败", err)
	}
	if _, err := lockDraftCount(ctx, q, actor, current.CountID); err != nil {
		return err
	}
	locked, err := q.LockStockCountItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "库存盘点单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定库存盘点单行失败", err)
	}
	item := itemFromRow(locked)
	if _, err := q.DeleteStockCountItem(ctx, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除库存盘点单行失败", err)
	}
	if err := writeItemAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(itemSnapshot(item), itemAuditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除库存盘点单行失败", err)
	}
	return nil
}

func lockDraftCount(
	ctx context.Context,
	q *dbgen.Queries,
	actor *authz.Actor,
	countID uuid.UUID,
) (Count, error) {
	row, err := q.LockStockCount(ctx, countID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Count{}, apierror.New(apierror.CodeNotFound, "库存盘点单不存在")
	}
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "锁定库存盘点单失败", err)
	}
	count := countFromRow(row)
	if err := requireCompany(actor, count.CompanyID); err != nil {
		return Count{}, err
	}
	if count.Status != StatusDraft {
		return Count{}, apierror.New(apierror.CodeConflict, "仅草稿库存盘点单可编辑单据行")
	}
	return count, nil
}

func buildItemProjection(
	ctx context.Context,
	q *dbgen.Queries,
	warehouseID uuid.UUID,
	materialID uuid.UUID,
	unitID uuid.UUID,
	counted *decimal.Decimal,
) (itemProjection, error) {
	row, err := q.GetStockCountItemProjection(
		ctx,
		dbgen.GetStockCountItemProjectionParams{
			WarehouseID: warehouseID, MaterialID: materialID, UnitID: unitID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, materialErr := q.GetMaterial(ctx, materialID); errors.Is(materialErr, pgx.ErrNoRows) {
			return itemProjection{}, apierror.Validation("库存盘点单行参数不合法", map[string][]string{
				"materialId": {"物料不存在"},
			})
		}
		return itemProjection{}, unitError()
	}
	if err != nil {
		return itemProjection{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位换算失败", err)
	}
	var converted *decimal.Decimal
	if counted != nil {
		value := *counted
		if row.DefaultUnitID != unitID {
			factor, ok := decimalFromNumeric(row.ConversionFactor)
			if !ok || !factor.IsPositive() {
				return itemProjection{}, unitError()
			}
			value = counted.Div(factor).Round(6)
		}
		converted = &value
	}
	return itemProjection{
		convertedCounted: converted, bookQuantity: row.BookQuantity,
		materialCode: row.MaterialCode, materialName: row.MaterialName,
		materialSpec: optionalText(row.MaterialSpec), unitName: row.UnitName,
	}, nil
}

func validateItemInput(
	materialID uuid.UUID,
	unitID uuid.UUID,
	counted *decimal.Decimal,
	remark *string,
) error {
	fields := map[string][]string{}
	if materialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if unitID == uuid.Nil {
		fields["unitId"] = []string{"必填"}
	}
	if counted != nil && counted.IsNegative() {
		fields["countedQuantity"] = []string{"不能小于零"}
	}
	if remark != nil && utf8.RuneCountInString(*remark) > 512 {
		fields["remark"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("库存盘点单行参数不合法", fields)
	}
	return nil
}

func unitError() error {
	return apierror.Validation("库存盘点单行参数不合法", map[string][]string{
		"unitId": {"单位必须是物料默认单位或其单位转换单位"},
	})
}

func decimalFromNumeric(value pgtype.Numeric) (decimal.Decimal, bool) {
	if !value.Valid || value.NaN || value.InfinityModifier != pgtype.Finite ||
		value.Int == nil {
		return decimal.Zero, false
	}
	return decimal.NewFromBigInt(new(big.Int).Set(value.Int), value.Exp), true
}

func numeric(value *decimal.Decimal) pgtype.Numeric {
	if value == nil {
		return pgtype.Numeric{}
	}
	n := pgtype.Numeric{}
	_ = n.Scan(value.String())
	return n
}

func decimalPointer(value pgtype.Numeric) *decimal.Decimal {
	result, ok := decimalFromNumeric(value)
	if !ok {
		return nil
	}
	return &result
}

func writeItemAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	item Item,
	actionType string,
	actionName string,
	changes map[string]audit.Change,
) error {
	companyID := item.CompanyID
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_stock_count_item", RecordID: item.ID,
		RecordLabel: item.MaterialCode, ActionType: actionType, ActionName: actionName,
		CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入库存盘点单行审计失败", err)
	}
	return nil
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"counted_quantity":  item.CountedQuantity,
		"converted_counted": item.ConvertedCounted,
		"book_quantity":     item.BookQuantity, "material_code": item.MaterialCode,
		"material_name": item.MaterialName, "material_spec": item.MaterialSpec,
		"unit_name": item.UnitName, "remark": item.Remark, "count_id": item.CountID,
		"company_id": item.CompanyID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func itemFromRow(row dbgen.InvStockCountItem) Item {
	return Item{
		ID: row.ID, CountedQuantity: decimalPointer(row.CountedQuantity),
		ConvertedCounted: decimalPointer(row.ConvertedCounted),
		BookQuantity:     row.BookQuantity, MaterialCode: row.MaterialCode,
		MaterialName: row.MaterialName, MaterialSpec: optionalText(row.MaterialSpec),
		UnitName: row.UnitName, Remark: optionalText(row.Remark),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CountID: row.CountID, CompanyID: row.CompanyID,
		MaterialID: row.MaterialID, UnitID: row.UnitID,
	}
}
