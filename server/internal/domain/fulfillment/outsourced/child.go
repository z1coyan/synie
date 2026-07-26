package outsourced

import (
	"context"
	"errors"
	"strconv"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var receiptChildAuditFields = []string{
	"idx", "qty", "base_qty", "material_code", "material_name", "material_spec",
	"unit_name", "order_no", "remarks", "receipt_item_id", "company_id",
	"source_id", "material_id", "unit_id", "warehouse_id",
}

type childSource struct {
	id            uuid.UUID
	orderItemID   uuid.UUID
	quantity      decimal.Decimal
	materialID    uuid.UUID
	defaultUnitID uuid.UUID
	unitID        uuid.UUID
	materialCode  string
	materialName  string
	materialSpec  *string
	unitName      string
	orderNo       string
}

func (s *Service) CreateReceiptMaterial(ctx context.Context, actor *authz.Actor, input CreateReceiptMaterialInput) (ReceiptMaterial, error) {
	if err := require(actor, receiptPermissionPrefix, "create"); err != nil {
		return ReceiptMaterial{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptMaterial{}, apierror.Wrap(apierror.CodeInternal, "创建委外入库材料行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, receipt, err := lockReceiptForItem(ctx, tx, actor, input.ReceiptItemID)
	if err != nil {
		return ReceiptMaterial{}, err
	}
	item, err := s.createReceiptMaterialInTx(ctx, tx, actor, receipt, parent, input)
	if err != nil {
		return ReceiptMaterial{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptMaterial{}, writeError("创建委外入库材料行", err)
	}
	return item, nil
}

func (s *Service) createReceiptMaterialInTx(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, receipt Receipt,
	parent ReceiptItem, input CreateReceiptMaterialInput,
) (ReceiptMaterial, error) {
	item := ReceiptMaterial{
		Idx: input.Idx, Qty: input.Qty, ReceiptItemID: parent.ID,
		OrderItemMaterialID:   input.OrderItemMaterialID,
		OutsourcedWarehouseID: input.OutsourcedWarehouseID, Remarks: input.Remarks,
	}
	if item.OutsourcedWarehouseID == nil {
		item.OutsourcedWarehouseID = receipt.OutsourcedWarehouseID
	}
	if err := deriveReceiptMaterial(ctx, tx, receipt, parent, &item); err != nil {
		return ReceiptMaterial{}, err
	}
	err := tx.QueryRow(ctx, `INSERT INTO pur_outsourced_receipt_item_material(
		idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
		remarks,receipt_item_id,company_id,order_item_material_id,material_id,unit_id,
		outsourced_warehouse_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
		item.Idx, item.Qty, item.BaseQty, item.MaterialCode, item.MaterialName,
		text(item.MaterialSpec), item.UnitName, item.OrderNo, text(item.Remarks),
		item.ReceiptItemID, item.CompanyID, item.OrderItemMaterialID, item.MaterialID,
		item.UnitID, item.OutsourcedWarehouseID).Scan(&item.ID)
	if err != nil {
		return ReceiptMaterial{}, writeError("创建委外入库材料行", err)
	}
	result, err := queryReceiptMaterial(ctx, tx, item.ID, false)
	if err != nil {
		return ReceiptMaterial{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外入库材料行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, materialTable, result.ID,
		strconv.FormatInt(result.Idx, 10), "create", "create", result.CompanyID,
		audit.Created(receiptMaterialSnapshot(result), receiptChildAuditFields)); err != nil {
		return ReceiptMaterial{}, err
	}
	return result, nil
}

func (s *Service) UpdateReceiptMaterial(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateReceiptMaterialInput) (ReceiptMaterial, error) {
	if err := require(actor, receiptPermissionPrefix, "update"); err != nil {
		return ReceiptMaterial{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptMaterial{}, apierror.Wrap(apierror.CodeInternal, "更新委外入库材料行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_item_id FROM pur_outsourced_receipt_item_material WHERE id=$1`, id).Scan(&parentID); err != nil {
		return ReceiptMaterial{}, apierror.New(apierror.CodeNotFound, "委外入库材料行不存在")
	}
	parent, receipt, err := lockReceiptForItem(ctx, tx, actor, parentID)
	if err != nil {
		return ReceiptMaterial{}, err
	}
	before, err := queryReceiptMaterial(ctx, tx, id, false)
	if err != nil {
		return ReceiptMaterial{}, apierror.New(apierror.CodeNotFound, "委外入库材料行不存在")
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.OrderItemMaterialID != nil {
		after.OrderItemMaterialID = *input.OrderItemMaterialID
	}
	if input.OutsourcedWarehouseID != nil {
		after.OutsourcedWarehouseID = *input.OutsourcedWarehouseID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := deriveReceiptMaterial(ctx, tx, receipt, parent, &after); err != nil {
		return ReceiptMaterial{}, err
	}
	changes := audit.Diff(receiptMaterialSnapshot(before), receiptMaterialSnapshot(after), receiptChildAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return ReceiptMaterial{}, writeError("更新委外入库材料行", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_receipt_item_material SET idx=$2,
		qty=$3,base_qty=$4,material_code=$5,material_name=$6,material_spec=$7,
		unit_name=$8,order_no=$9,remarks=$10,order_item_material_id=$11,
		material_id=$12,unit_id=$13,outsourced_warehouse_id=$14,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.Qty, after.BaseQty, after.MaterialCode, after.MaterialName,
		text(after.MaterialSpec), after.UnitName, after.OrderNo, text(after.Remarks),
		after.OrderItemMaterialID, after.MaterialID, after.UnitID,
		after.OutsourcedWarehouseID)
	if err != nil {
		return ReceiptMaterial{}, writeError("更新委外入库材料行", err)
	}
	result, err := queryReceiptMaterial(ctx, tx, id, false)
	if err != nil {
		return ReceiptMaterial{}, err
	}
	if err := writeAudit(ctx, tx, actor, materialTable, id,
		strconv.FormatInt(result.Idx, 10), "update", "update", result.CompanyID, changes); err != nil {
		return ReceiptMaterial{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptMaterial{}, writeError("更新委外入库材料行", err)
	}
	return result, nil
}

func (s *Service) DeleteReceiptMaterial(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	return s.deleteReceiptChild(ctx, actor, id, true)
}

func (s *Service) CreateReceiptByproduct(ctx context.Context, actor *authz.Actor, input CreateReceiptByproductInput) (ReceiptByproduct, error) {
	if err := require(actor, receiptPermissionPrefix, "create"); err != nil {
		return ReceiptByproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptByproduct{}, apierror.Wrap(apierror.CodeInternal, "创建委外入库副产物行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, receipt, err := lockReceiptForItem(ctx, tx, actor, input.ReceiptItemID)
	if err != nil {
		return ReceiptByproduct{}, err
	}
	item, err := s.createReceiptByproductInTx(ctx, tx, actor, receipt, parent, input)
	if err != nil {
		return ReceiptByproduct{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptByproduct{}, writeError("创建委外入库副产物行", err)
	}
	return item, nil
}

func (s *Service) createReceiptByproductInTx(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, receipt Receipt,
	parent ReceiptItem, input CreateReceiptByproductInput,
) (ReceiptByproduct, error) {
	item := ReceiptByproduct{
		Idx: input.Idx, Qty: input.Qty, ReceiptItemID: parent.ID,
		OrderItemByproductID: input.OrderItemByproductID,
		WarehouseID:          input.WarehouseID, Remarks: input.Remarks,
	}
	if item.WarehouseID == nil {
		item.WarehouseID = receipt.WarehouseID
	}
	if err := deriveReceiptByproduct(ctx, tx, receipt, parent, &item); err != nil {
		return ReceiptByproduct{}, err
	}
	err := tx.QueryRow(ctx, `INSERT INTO pur_outsourced_receipt_item_byproduct(
		idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
		remarks,receipt_item_id,company_id,order_item_byproduct_id,material_id,unit_id,
		warehouse_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
		item.Idx, item.Qty, item.BaseQty, item.MaterialCode, item.MaterialName,
		text(item.MaterialSpec), item.UnitName, item.OrderNo, text(item.Remarks),
		item.ReceiptItemID, item.CompanyID, item.OrderItemByproductID, item.MaterialID,
		item.UnitID, item.WarehouseID).Scan(&item.ID)
	if err != nil {
		return ReceiptByproduct{}, writeError("创建委外入库副产物行", err)
	}
	result, err := queryReceiptByproduct(ctx, tx, item.ID, false)
	if err != nil {
		return ReceiptByproduct{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外入库副产物行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, byproductTable, result.ID,
		strconv.FormatInt(result.Idx, 10), "create", "create", result.CompanyID,
		audit.Created(receiptByproductSnapshot(result), receiptChildAuditFields)); err != nil {
		return ReceiptByproduct{}, err
	}
	return result, nil
}

func (s *Service) UpdateReceiptByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateReceiptByproductInput) (ReceiptByproduct, error) {
	if err := require(actor, receiptPermissionPrefix, "update"); err != nil {
		return ReceiptByproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptByproduct{}, apierror.Wrap(apierror.CodeInternal, "更新委外入库副产物行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_item_id FROM pur_outsourced_receipt_item_byproduct WHERE id=$1`, id).Scan(&parentID); err != nil {
		return ReceiptByproduct{}, apierror.New(apierror.CodeNotFound, "委外入库副产物行不存在")
	}
	parent, receipt, err := lockReceiptForItem(ctx, tx, actor, parentID)
	if err != nil {
		return ReceiptByproduct{}, err
	}
	before, err := queryReceiptByproduct(ctx, tx, id, false)
	if err != nil {
		return ReceiptByproduct{}, apierror.New(apierror.CodeNotFound, "委外入库副产物行不存在")
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.OrderItemByproductID != nil {
		after.OrderItemByproductID = *input.OrderItemByproductID
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := deriveReceiptByproduct(ctx, tx, receipt, parent, &after); err != nil {
		return ReceiptByproduct{}, err
	}
	changes := audit.Diff(receiptByproductSnapshot(before), receiptByproductSnapshot(after), receiptChildAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return ReceiptByproduct{}, writeError("更新委外入库副产物行", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_receipt_item_byproduct SET idx=$2,
		qty=$3,base_qty=$4,material_code=$5,material_name=$6,material_spec=$7,
		unit_name=$8,order_no=$9,remarks=$10,order_item_byproduct_id=$11,
		material_id=$12,unit_id=$13,warehouse_id=$14,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.Qty, after.BaseQty, after.MaterialCode, after.MaterialName,
		text(after.MaterialSpec), after.UnitName, after.OrderNo, text(after.Remarks),
		after.OrderItemByproductID, after.MaterialID, after.UnitID, after.WarehouseID)
	if err != nil {
		return ReceiptByproduct{}, writeError("更新委外入库副产物行", err)
	}
	result, err := queryReceiptByproduct(ctx, tx, id, false)
	if err != nil {
		return ReceiptByproduct{}, err
	}
	if err := writeAudit(ctx, tx, actor, byproductTable, id,
		strconv.FormatInt(result.Idx, 10), "update", "update", result.CompanyID, changes); err != nil {
		return ReceiptByproduct{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptByproduct{}, writeError("更新委外入库副产物行", err)
	}
	return result, nil
}

func (s *Service) DeleteReceiptByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	return s.deleteReceiptChild(ctx, actor, id, false)
}

func (s *Service) deleteReceiptChild(ctx context.Context, actor *authz.Actor, id uuid.UUID, material bool) error {
	if err := require(actor, receiptPermissionPrefix, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除委外入库子行失败", err)
	}
	defer tx.Rollback(ctx)
	table := byproductTable
	if material {
		table = materialTable
	}
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_item_id FROM `+table+` WHERE id=$1`, id).Scan(&parentID); err != nil {
		return apierror.New(apierror.CodeNotFound, "委外入库子行不存在")
	}
	if _, _, err := lockReceiptForItem(ctx, tx, actor, parentID); err != nil {
		return err
	}
	if material {
		item, err := queryReceiptMaterial(ctx, tx, id, false)
		if err != nil {
			return apierror.New(apierror.CodeNotFound, "委外入库材料行不存在")
		}
		if err := writeAudit(ctx, tx, actor, table, id, strconv.FormatInt(item.Idx, 10),
			"destroy", "destroy", item.CompanyID,
			audit.Destroyed(receiptMaterialSnapshot(item), receiptChildAuditFields)); err != nil {
			return err
		}
	} else {
		item, err := queryReceiptByproduct(ctx, tx, id, false)
		if err != nil {
			return apierror.New(apierror.CodeNotFound, "委外入库副产物行不存在")
		}
		if err := writeAudit(ctx, tx, actor, table, id, strconv.FormatInt(item.Idx, 10),
			"destroy", "destroy", item.CompanyID,
			audit.Destroyed(receiptByproductSnapshot(item), receiptChildAuditFields)); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id); err != nil {
		return writeError("删除委外入库子行", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除委外入库子行", err)
	}
	return nil
}

func lockReceiptForItem(ctx context.Context, tx pgx.Tx, actor *authz.Actor, itemID uuid.UUID) (ReceiptItem, Receipt, error) {
	var receiptID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=$1`, itemID).Scan(&receiptID); err != nil {
		return ReceiptItem{}, Receipt{}, apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	receipt, err := lockDraftReceipt(ctx, tx, actor, receiptID)
	if err != nil {
		return ReceiptItem{}, Receipt{}, err
	}
	item, err := queryReceiptItem(ctx, tx, itemID, false)
	if err != nil {
		return ReceiptItem{}, Receipt{}, apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	return item, receipt, nil
}

func deriveReceiptMaterial(ctx context.Context, tx pgx.Tx, receipt Receipt, parent ReceiptItem, item *ReceiptMaterial) error {
	if err := validateChildShape(item.Qty, item.OrderItemMaterialID, item.Remarks); err != nil {
		return err
	}
	source, err := loadChildSource(ctx, tx, true, item.OrderItemMaterialID)
	if err != nil {
		return err
	}
	if source.orderItemID != parent.OrderItemID {
		return apierror.Validation("委外入库材料行参数不合法", map[string][]string{"orderItemMaterialId": {"来源必须属于父成品行的订单行"}})
	}
	if item.OutsourcedWarehouseID != nil {
		if err := validateOutsourcedWarehouse(ctx, tx, receipt.CompanyID, receipt.PartyType, receipt.PartyID, *item.OutsourcedWarehouseID); err != nil {
			return err
		}
	}
	baseQty, _, err := deriveBaseQty(ctx, tx, source.materialID, source.defaultUnitID, source.unitID, item.Qty)
	if err != nil {
		return err
	}
	item.BaseQty, item.CompanyID = baseQty, receipt.CompanyID
	item.MaterialID, item.UnitID = source.materialID, source.unitID
	item.MaterialCode, item.MaterialName, item.MaterialSpec = source.materialCode, source.materialName, source.materialSpec
	item.UnitName, item.OrderNo = source.unitName, source.orderNo
	return nil
}

func deriveReceiptByproduct(ctx context.Context, tx pgx.Tx, receipt Receipt, parent ReceiptItem, item *ReceiptByproduct) error {
	if err := validateChildShape(item.Qty, item.OrderItemByproductID, item.Remarks); err != nil {
		return err
	}
	source, err := loadChildSource(ctx, tx, false, item.OrderItemByproductID)
	if err != nil {
		return err
	}
	if source.orderItemID != parent.OrderItemID {
		return apierror.Validation("委外入库副产物行参数不合法", map[string][]string{"orderItemByproductId": {"来源必须属于父成品行的订单行"}})
	}
	if item.WarehouseID != nil {
		if err := validateWarehouse(ctx, tx, receipt.CompanyID, *item.WarehouseID); err != nil {
			return err
		}
	}
	baseQty, _, err := deriveBaseQty(ctx, tx, source.materialID, source.defaultUnitID, source.unitID, item.Qty)
	if err != nil {
		return err
	}
	item.BaseQty, item.CompanyID = baseQty, receipt.CompanyID
	item.MaterialID, item.UnitID = source.materialID, source.unitID
	item.MaterialCode, item.MaterialName, item.MaterialSpec = source.materialCode, source.materialName, source.materialSpec
	item.UnitName, item.OrderNo = source.unitName, source.orderNo
	return nil
}

func validateChildShape(qty decimal.Decimal, sourceID uuid.UUID, remarks *string) error {
	fields := map[string][]string{}
	if !qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if sourceID == uuid.Nil {
		fields["sourceId"] = []string{"来源清单行必填"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("委外入库子行参数不合法", fields)
	}
	return nil
}

func loadChildSource(ctx context.Context, tx pgx.Tx, material bool, id uuid.UUID) (childSource, error) {
	table := "pur_order_item_byproduct"
	if material {
		table = "pur_order_item_material"
	}
	var result childSource
	var spec pgtype.Text
	err := tx.QueryRow(ctx, `SELECT l.id,l.order_item_id,l.quantity,l.material_id,
		m.default_unit_id,l.unit_id,m.code,m.name,m.spec,u.name,o.order_no
		FROM `+table+` l
		JOIN pur_order_item i ON i.id=l.order_item_id
		JOIN pur_order o ON o.id=i.order_id
		JOIN inv_material m ON m.id=l.material_id
		JOIN bas_unit u ON u.id=l.unit_id WHERE l.id=$1`, id).Scan(
		&result.id, &result.orderItemID, &result.quantity, &result.materialID,
		&result.defaultUnitID, &result.unitID, &result.materialCode,
		&result.materialName, &spec, &result.unitName, &result.orderNo)
	if errors.Is(err, pgx.ErrNoRows) {
		return childSource{}, apierror.Validation("委外入库子行参数不合法", map[string][]string{"sourceId": {"来源清单行不存在"}})
	}
	if err != nil {
		return childSource{}, apierror.Wrap(apierror.CodeInternal, "读取委外入库子行来源失败", err)
	}
	result.materialSpec = textPtr(spec)
	return result, nil
}

func (s *Service) carryReceiptChildren(ctx context.Context, tx pgx.Tx, actor *authz.Actor, receipt Receipt, parent ReceiptItem) error {
	ratio := parent.BaseQty.Div(parent.OrderBaseQty)
	for _, material := range []bool{true, false} {
		table := "pur_order_item_byproduct"
		if material {
			table = "pur_order_item_material"
		}
		rows, err := tx.Query(ctx, `SELECT id,quantity FROM `+table+`
			WHERE order_item_id=$1 ORDER BY inserted_at,id`, parent.OrderItemID)
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取待带出委外清单失败", err)
		}
		type sourceLine struct {
			id  uuid.UUID
			qty decimal.Decimal
		}
		sources := make([]sourceLine, 0)
		for rows.Next() {
			var source sourceLine
			if err := rows.Scan(&source.id, &source.qty); err != nil {
				rows.Close()
				return err
			}
			sources = append(sources, source)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "遍历待带出委外清单失败", err)
		}
		rows.Close()
		idx := int64(0)
		for _, source := range sources {
			qty := source.qty.Mul(ratio).Round(6)
			if !qty.GreaterThan(decimal.Zero) {
				continue
			}
			if material {
				if _, err := s.createReceiptMaterialInTx(ctx, tx, actor, receipt, parent, CreateReceiptMaterialInput{
					ReceiptItemID: parent.ID, Idx: idx, Qty: qty,
					OrderItemMaterialID:   source.id,
					OutsourcedWarehouseID: receipt.OutsourcedWarehouseID,
				}); err != nil {
					return err
				}
			} else {
				if _, err := s.createReceiptByproductInTx(ctx, tx, actor, receipt, parent, CreateReceiptByproductInput{
					ReceiptItemID: parent.ID, Idx: idx, Qty: qty,
					OrderItemByproductID: source.id, WarehouseID: receipt.WarehouseID,
				}); err != nil {
					return err
				}
			}
			idx++
		}
	}
	return nil
}

// AdjustReconciledQty is the only write seam exposed to purchase
// reconciliation. The caller owns tx. It serializes with void by locking the
// top-level receipt before the controlled projection row.
func (s *Service) AdjustReconciledQty(ctx context.Context, tx pgx.Tx, input AdjustReconciledQtyInput) error {
	if input.ReceiptItemID == uuid.Nil || input.Delta.IsZero() {
		return apierror.Validation("对账投影参数不合法", map[string][]string{"input": {"成品行和非零增量必填"}})
	}
	var receiptID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=$1`, input.ReceiptItemID).Scan(&receiptID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
		}
		return apierror.Wrap(apierror.CodeInternal, "读取对账投影父单失败", err)
	}
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM pur_outsourced_receipt WHERE id=$1 FOR UPDATE`, receiptID).Scan(&status); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定委外入库单失败", err)
	}
	if status != "audited" {
		return apierror.New(apierror.CodeConflict, "仅已审核委外入库行可调整对账投影")
	}
	var current decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT reconciled_qty FROM pur_outsourced_receipt_item
		WHERE id=$1 FOR UPDATE`, input.ReceiptItemID).Scan(&current); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定对账投影失败", err)
	}
	next := current.Add(input.Delta)
	if next.IsNegative() {
		return apierror.New(apierror.CodeConflict, "已对账数量不能为负")
	}
	if _, err := tx.Exec(ctx, `UPDATE pur_outsourced_receipt_item SET reconciled_qty=$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, input.ReceiptItemID, next); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "更新对账投影失败", err)
	}
	return nil
}

func receiptMaterialSnapshot(item ReceiptMaterial) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName,
		"order_no": item.OrderNo, "remarks": item.Remarks,
		"receipt_item_id": item.ReceiptItemID, "company_id": item.CompanyID,
		"source_id": item.OrderItemMaterialID, "material_id": item.MaterialID,
		"unit_id": item.UnitID, "warehouse_id": item.OutsourcedWarehouseID,
	}
}

func receiptByproductSnapshot(item ReceiptByproduct) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName,
		"order_no": item.OrderNo, "remarks": item.Remarks,
		"receipt_item_id": item.ReceiptItemID, "company_id": item.CompanyID,
		"source_id": item.OrderItemByproductID, "material_id": item.MaterialID,
		"unit_id": item.UnitID, "warehouse_id": item.WarehouseID,
	}
}
