package stockdoc

import (
	"context"
	"errors"
	"math/big"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type itemProjection struct {
	baseQty      decimal.Decimal
	materialCode string
	materialName string
	materialSpec *string
	unitName     string
}

func (s *Service) GetItem(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (Item, error) {
	if err := require(actor, "read"); err != nil {
		return Item{}, err
	}
	row, err := dbgen.New(s.pool).GetStockDocItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	return itemFromRow(row), nil
}

func (s *Service) ListItems(
	ctx context.Context,
	actor *authz.Actor,
	docID uuid.UUID,
) ([]Item, error) {
	if err := require(actor, "read"); err != nil {
		return nil, err
	}
	q := dbgen.New(s.pool)
	doc, err := q.GetStockDoc(ctx, docID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(doc.CompanyID)) {
		return nil, apierror.New(apierror.CodeNotFound, "手工出入库单不存在")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单失败", err)
	}
	rows, err := q.ListStockDocItems(ctx, docID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行失败", err)
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
	if err := validateItemInput(input.Qty, input.MaterialID, input.UnitID, input.Remark); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工出入库单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	doc, err := lockDraftDoc(ctx, q, actor, input.StockDocID)
	if err != nil {
		return Item{}, err
	}
	projection, err := buildProjection(ctx, q, input.MaterialID, input.UnitID, input.Qty)
	if err != nil {
		return Item{}, err
	}
	row, err := q.CreateStockDocItem(ctx, dbgen.CreateStockDocItemParams{
		Idx: input.Idx, Qty: input.Qty, BaseQty: projection.baseQty,
		MaterialCode: projection.materialCode, MaterialName: projection.materialName,
		MaterialSpec: pgconv.Text(projection.materialSpec), UnitName: projection.unitName,
		Remark: pgconv.Text(input.Remark), StockDocID: input.StockDocID,
		CompanyID: doc.CompanyID, MaterialID: input.MaterialID, UnitID: input.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工出入库单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(itemSnapshot(item), itemAuditedFields)); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建手工出入库单行失败", err)
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
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockDocItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行失败", err)
	}
	if _, err := lockDraftDoc(ctx, q, actor, current.StockDocID); err != nil {
		return Item{}, err
	}
	locked, err := q.LockStockDocItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "锁定手工出入库单行失败", err)
	}
	before := itemFromRow(locked)
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Remark != nil {
		after.Remark = *input.Remark
	}
	if err := validateItemInput(after.Qty, after.MaterialID, after.UnitID, after.Remark); err != nil {
		return Item{}, err
	}
	projection, err := buildProjection(ctx, q, after.MaterialID, after.UnitID, after.Qty)
	if err != nil {
		return Item{}, err
	}
	after.BaseQty = projection.baseQty
	after.MaterialCode = projection.materialCode
	after.MaterialName = projection.materialName
	after.MaterialSpec = projection.materialSpec
	after.UnitName = projection.unitName
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单行失败", err)
		}
		return before, nil
	}
	row, err := q.UpdateStockDocItem(ctx, dbgen.UpdateStockDocItemParams{
		ID: id, Idx: after.Idx, Qty: after.Qty, BaseQty: after.BaseQty,
		MaterialCode: after.MaterialCode, MaterialName: after.MaterialName,
		MaterialSpec: pgconv.Text(after.MaterialSpec), UnitName: after.UnitName,
		Remark: pgconv.Text(after.Remark), MaterialID: after.MaterialID, UnitID: after.UnitID,
	})
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单行失败", err)
	}
	item := itemFromRow(row)
	if err := writeItemAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单行失败", err)
	}
	return item, nil
}

func (s *Service) DeleteItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工出入库单行失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	current, err := q.GetStockDocItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行失败", err)
	}
	if _, err := lockDraftDoc(ctx, q, actor, current.StockDocID); err != nil {
		return err
	}
	locked, err := q.LockStockDocItem(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工出入库单行不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定手工出入库单行失败", err)
	}
	item := itemFromRow(locked)
	if _, err := q.DeleteStockDocItem(ctx, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工出入库单行失败", err)
	}
	if err := writeItemAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(itemSnapshot(item), itemAuditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工出入库单行失败", err)
	}
	return nil
}

func lockDraftDoc(
	ctx context.Context,
	q *dbgen.Queries,
	actor *authz.Actor,
	docID uuid.UUID,
) (Doc, error) {
	row, err := q.LockStockDoc(ctx, docID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Doc{}, apierror.New(apierror.CodeNotFound, "手工出入库单不存在")
	}
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "锁定手工出入库单失败", err)
	}
	doc := docFromRow(row)
	if err := requireCompany(actor, doc.CompanyID); err != nil {
		return Doc{}, err
	}
	if doc.Status != StatusDraft {
		return Doc{}, apierror.New(apierror.CodeConflict, "仅草稿手工出入库单可编辑单据行")
	}
	return doc, nil
}

func buildProjection(
	ctx context.Context,
	q *dbgen.Queries,
	materialID uuid.UUID,
	unitID uuid.UUID,
	qty decimal.Decimal,
) (itemProjection, error) {
	row, err := q.GetStockItemProjection(ctx, dbgen.GetStockItemProjectionParams{
		MaterialID: materialID, UnitID: unitID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		if _, materialErr := q.GetMaterial(ctx, materialID); errors.Is(materialErr, pgx.ErrNoRows) {
			return itemProjection{}, apierror.Validation("手工出入库单行参数不合法", map[string][]string{
				"materialId": {"物料不存在"},
			})
		}
		return itemProjection{}, unitError()
	}
	if err != nil {
		return itemProjection{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位换算失败", err)
	}
	baseQty := qty
	if row.DefaultUnitID != unitID {
		factor, ok := decimalFromNumeric(row.ConversionFactor)
		if !ok || !factor.IsPositive() {
			return itemProjection{}, unitError()
		}
		baseQty = qty.Div(factor).Round(6)
	}
	return itemProjection{
		baseQty: baseQty, materialCode: row.MaterialCode,
		materialName: row.MaterialName, materialSpec: pgconv.TextPtr(row.MaterialSpec),
		unitName: row.UnitName,
	}, nil
}

func validateItemInput(
	qty decimal.Decimal,
	materialID uuid.UUID,
	unitID uuid.UUID,
	remark *string,
) error {
	fields := map[string][]string{}
	if !qty.IsPositive() {
		fields["qty"] = []string{"数量必须大于零"}
	}
	if materialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if unitID == uuid.Nil {
		fields["unitId"] = []string{"必填"}
	}
	if remark != nil && utf8.RuneCountInString(*remark) > 512 {
		fields["remark"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("手工出入库单行参数不合法", fields)
	}
	return nil
}

func unitError() error {
	return apierror.Validation("手工出入库单行参数不合法", map[string][]string{
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
		Resource: "inv_stock_doc_item", RecordID: item.ID,
		RecordLabel: item.MaterialCode, ActionType: actionType, ActionName: actionName,
		CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入手工出入库单行审计失败", err)
	}
	return nil
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName,
		"remark": item.Remark, "stock_doc_id": item.StockDocID,
		"company_id": item.CompanyID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func itemFromRow(row dbgen.InvStockDocItem) Item {
	return Item{
		ID: row.ID, Idx: row.Idx, Qty: row.Qty, BaseQty: row.BaseQty,
		MaterialCode: row.MaterialCode, MaterialName: row.MaterialName,
		MaterialSpec: pgconv.TextPtr(row.MaterialSpec), UnitName: row.UnitName,
		Remark: pgconv.TextPtr(row.Remark), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), StockDocID: row.StockDocID,
		CompanyID: row.CompanyID, MaterialID: row.MaterialID, UnitID: row.UnitID,
	}
}

func optionalDate(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
