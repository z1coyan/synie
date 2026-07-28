package stocktransfer

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

func lockDraftTransfer(ctx context.Context, q *dbgen.Queries, actor *authz.Actor, id uuid.UUID) (Transfer, error) {
	row, err := q.LockStockTransfer(ctx, id)
	if err := lockError(err, "锁定手工调拨单失败"); err != nil {
		return Transfer{}, err
	}
	item := transferFromRow(row)
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return Transfer{}, err
	}
	if item.Status != StatusDraft {
		return Transfer{}, apierror.New(apierror.CodeConflict, "仅草稿调拨单可编辑单据行")
	}
	return item, nil
}

func buildProjection(ctx context.Context, q *dbgen.Queries, materialID, unitID uuid.UUID, qty decimal.Decimal) (itemProjection, error) {
	row, err := q.GetStockTransferItemProjection(ctx, dbgen.GetStockTransferItemProjectionParams{
		MaterialID: materialID, UnitID: unitID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return itemProjection{}, unitError()
	}
	if err != nil {
		return itemProjection{}, apierror.Wrap(apierror.CodeInternal, "读取物料单位信息失败", err)
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
		baseQty: baseQty, materialCode: row.MaterialCode, materialName: row.MaterialName,
		materialSpec: pgconv.TextPtr(row.MaterialSpec), unitName: row.UnitName,
	}, nil
}

func validateItemInput(qty decimal.Decimal, materialID, unitID uuid.UUID, remark *string) error {
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
		return apierror.Validation("手工调拨单行参数不合法", fields)
	}
	return nil
}

func unitError() error {
	return apierror.Validation("手工调拨单行参数不合法", map[string][]string{
		"unitId": {"单位必须是物料默认单位或其单位转换单位"},
	})
}

func decimalFromNumeric(value pgtype.Numeric) (decimal.Decimal, bool) {
	if !value.Valid || value.NaN || value.InfinityModifier != pgtype.Finite || value.Int == nil {
		return decimal.Zero, false
	}
	return decimal.NewFromBigInt(new(big.Int).Set(value.Int), value.Exp), true
}

func writeItemAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, item Item, actionType, actionName string, changes map[string]audit.Change) error {
	companyID := item.CompanyID
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_stock_transfer_item", RecordID: item.ID, RecordLabel: item.MaterialCode,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID, Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入手工调拨单行审计失败", err)
	}
	return nil
}

var itemAuditedFields = []string{
	"idx", "qty", "base_qty", "received_qty", "material_code", "material_name",
	"material_spec", "unit_name", "remark", "stock_transfer_id", "company_id", "material_id", "unit_id",
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty, "received_qty": item.ReceivedQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName, "remark": item.Remark,
		"stock_transfer_id": item.StockTransferID, "company_id": item.CompanyID,
		"material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func itemFromRow(row dbgen.InvStockTransferItem) Item {
	var received *decimal.Decimal
	if value, ok := decimalFromNumeric(row.ReceivedQty); ok {
		received = &value
	}
	return Item{
		ID: row.ID, Idx: row.Idx, Qty: row.Qty, BaseQty: row.BaseQty, ReceivedQty: received,
		MaterialCode: row.MaterialCode, MaterialName: row.MaterialName,
		MaterialSpec: pgconv.TextPtr(row.MaterialSpec), UnitName: row.UnitName,
		Remark: pgconv.TextPtr(row.Remark), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), StockTransferID: row.StockTransferID,
		CompanyID: row.CompanyID, MaterialID: row.MaterialID, UnitID: row.UnitID,
	}
}
