package standard

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var itemAuditFields = []string{
	"idx", "qty", "base_qty", "material_code", "material_name", "material_spec",
	"customer_part_no", "unit_name", "order_no", "order_qty", "order_base_qty",
	"order_unit_name", "order_price", "order_amount", "order_base_price",
	"order_base_amount", "order_tax_rate", "order_currency_code", "reconciled_qty",
	"remarks", "head_id", "company_id", "order_item_id", "material_id", "unit_id",
	"warehouse_id",
}

type orderItemSnapshot struct {
	orderID           uuid.UUID
	orderItemID       uuid.UUID
	companyID         uuid.UUID
	partyType         string
	partyID           uuid.UUID
	orderStatus       string
	orderNo           string
	orderCurrencyCode string
	materialID        uuid.UUID
	defaultUnitID     uuid.UUID
	orderUnitID       uuid.UUID
	orderQty          decimal.Decimal
	orderBaseQty      decimal.Decimal
	orderUnitName     string
	orderPrice        decimal.Decimal
	orderAmount       decimal.Decimal
	orderBasePrice    decimal.Decimal
	orderBaseAmount   decimal.Decimal
	orderTaxRate      decimal.Decimal
	materialCode      string
	materialName      string
	materialSpec      *string
	customerPartNo    *string
}

func (s *Service) CreateItem(
	ctx context.Context, actor *authz.Actor, side Side, input CreateItemInput,
) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建"+spec.itemLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockDraftHead(ctx, tx, actor, spec, input.HeadID)
	if err != nil {
		return Item{}, err
	}
	item := Item{
		Idx: input.Idx, Qty: input.Qty, HeadID: input.HeadID, CompanyID: parent.CompanyID,
		OrderItemID: input.OrderItemID, WarehouseID: input.WarehouseID, Remarks: input.Remarks,
	}
	if err := s.deriveItem(ctx, tx, spec, parent, &item, input.UnitID, nil); err != nil {
		return Item{}, err
	}
	parentColumn := "delivery_id"
	if side == SidePurchase {
		parentColumn = "receipt_id"
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+spec.itemTable+` (
		idx,qty,base_qty,material_code,material_name,material_spec,customer_part_no,unit_name,
		order_no,order_qty,order_base_qty,order_unit_name,order_price,order_amount,
		order_base_price,order_base_amount,order_tax_rate,order_currency_code,reconciled_qty,
		remarks,`+parentColumn+`,company_id,order_item_id,material_id,unit_id,warehouse_id
	) VALUES (
		$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,
		$20,$21,$22,$23,$24,$25
	) RETURNING id`,
		item.Idx, item.Qty, item.BaseQty, item.MaterialCode, item.MaterialName,
		pgconv.Text(item.MaterialSpec), pgconv.Text(item.CustomerPartNo), item.UnitName, item.OrderNo,
		item.OrderQty, item.OrderBaseQty, item.OrderUnitName, item.OrderPrice,
		item.OrderAmount, item.OrderBasePrice, item.OrderBaseAmount, item.OrderTaxRate,
		item.OrderCurrencyCode, pgconv.Text(item.Remarks), item.HeadID, item.CompanyID,
		item.OrderItemID, item.MaterialID, item.UnitID, item.WarehouseID,
	).Scan(&id)
	if err != nil {
		return Item{}, writeError(spec, "创建"+spec.itemLabel+"失败", err)
	}
	if err := syncItemDrawings(ctx, tx, spec, id, item.MaterialID, item.CompanyID); err != nil {
		return Item{}, err
	}
	result, err := queryItemByID(ctx, tx, spec, id, false)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取新建"+spec.itemLabel+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(result.Idx, 10),
		"create", "create", result.CompanyID,
		audit.Created(itemSnapshot(result), itemAuditFields)); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError(spec, "创建"+spec.itemLabel+"失败", err)
	}
	return result, nil
}

func (s *Service) UpdateItem(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input UpdateItemInput,
) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Item{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新"+spec.itemLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parentID, err := findItemParent(ctx, tx, spec, id)
	if err != nil {
		return Item{}, err
	}
	parent, err := lockDraftHead(ctx, tx, actor, spec, parentID)
	if err != nil {
		return Item{}, err
	}
	before, err := queryItemByID(ctx, tx, spec, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, apierror.New(apierror.CodeNotFound, spec.itemLabel+"不存在")
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "锁定"+spec.itemLabel+"失败", err)
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.OrderItemID != nil {
		after.OrderItemID = *input.OrderItemID
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	var unitID *uuid.UUID
	if input.UnitID.Set {
		unitID = input.UnitID.Value
	} else {
		unitID = &after.UnitID
	}
	if err := s.deriveItem(ctx, tx, spec, parent, &after, unitID, &id); err != nil {
		return Item{}, err
	}
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, writeError(spec, "更新"+spec.itemLabel+"失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.itemTable+` SET
		idx=$2,qty=$3,base_qty=$4,material_code=$5,material_name=$6,material_spec=$7,
		customer_part_no=$8,unit_name=$9,order_no=$10,order_qty=$11,order_base_qty=$12,
		order_unit_name=$13,order_price=$14,order_amount=$15,order_base_price=$16,
		order_base_amount=$17,order_tax_rate=$18,order_currency_code=$19,remarks=$20,
		order_item_id=$21,material_id=$22,unit_id=$23,warehouse_id=$24,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.Qty, after.BaseQty, after.MaterialCode, after.MaterialName,
		pgconv.Text(after.MaterialSpec), pgconv.Text(after.CustomerPartNo), after.UnitName, after.OrderNo,
		after.OrderQty, after.OrderBaseQty, after.OrderUnitName, after.OrderPrice,
		after.OrderAmount, after.OrderBasePrice, after.OrderBaseAmount, after.OrderTaxRate,
		after.OrderCurrencyCode, pgconv.Text(after.Remarks), after.OrderItemID, after.MaterialID,
		after.UnitID, after.WarehouseID,
	)
	if err != nil {
		return Item{}, writeError(spec, "更新"+spec.itemLabel+"失败", err)
	}
	if err := syncItemDrawings(ctx, tx, spec, id, after.MaterialID, after.CompanyID); err != nil {
		return Item{}, err
	}
	result, err := queryItemByID(ctx, tx, spec, id, false)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取更新后"+spec.itemLabel+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(result.Idx, 10),
		"update", "update", result.CompanyID, changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError(spec, "更新"+spec.itemLabel+"失败", err)
	}
	return result, nil
}

func (s *Service) DeleteItem(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除"+spec.itemLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parentID, err := findItemParent(ctx, tx, spec, id)
	if err != nil {
		return err
	}
	if _, err := lockDraftHead(ctx, tx, actor, spec, parentID); err != nil {
		return err
	}
	item, err := queryItemByID(ctx, tx, spec, id, true)
	if err != nil {
		return apierror.New(apierror.CodeNotFound, spec.itemLabel+"不存在")
	}
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(item.Idx, 10),
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(itemSnapshot(item), itemAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1 AND owner_id=$2`,
		spec.itemOwnerType, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "清理"+spec.itemLabel+"图纸失败", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.itemTable+` WHERE id=$1`, id); err != nil {
		return writeError(spec, "删除"+spec.itemLabel+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError(spec, "删除"+spec.itemLabel+"失败", err)
	}
	return nil
}

func (s *Service) deriveItem(
	ctx context.Context,
	tx pgx.Tx,
	spec sideSpec,
	parent Head,
	item *Item,
	unitID *uuid.UUID,
	excludeItemID *uuid.UUID,
) error {
	fields := map[string][]string{}
	if !item.Qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if item.OrderItemID == uuid.Nil {
		fields["orderItemId"] = []string{"必填"}
	}
	if item.WarehouseID == uuid.Nil {
		fields["warehouseId"] = []string{"必填"}
	}
	if item.Remarks != nil && utf8.RuneCountInString(*item.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(spec.itemLabel+"参数不合法", fields)
	}
	if err := validateWarehouse(ctx, tx, parent.CompanyID, item.WarehouseID); err != nil {
		return err
	}
	source, err := loadOrderItemSnapshot(ctx, tx, spec, item.OrderItemID)
	if err != nil {
		return err
	}
	if source.orderStatus != "audited" {
		return apierror.Validation(spec.itemLabel+"参数不合法",
			map[string][]string{"orderItemId": {"来源订单须为已审核"}})
	}
	if source.companyID != parent.CompanyID || source.partyType != parent.PartyType ||
		source.partyID != parent.PartyID {
		return apierror.Validation(spec.itemLabel+"参数不合法",
			map[string][]string{"orderItemId": {"来源订单公司或对手与履约单不一致"}})
	}
	chosenUnitID := source.orderUnitID
	if unitID != nil && *unitID != uuid.Nil {
		chosenUnitID = *unitID
	}
	var unitName string
	var factor pgtype.Numeric
	err = tx.QueryRow(ctx, `SELECT u.name,mu.factor FROM bas_unit u
		LEFT JOIN inv_material_unit mu ON mu.material_id=$1 AND mu.unit_id=u.id
		WHERE u.id=$2`, source.materialID, chosenUnitID).Scan(&unitName, &factor)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation(spec.itemLabel+"参数不合法",
			map[string][]string{"unitId": {"单位不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取履约单位失败", err)
	}
	baseQty := item.Qty
	if chosenUnitID != source.defaultUnitID {
		conversion, ok := numericDecimal(factor)
		if !ok || !conversion.GreaterThan(decimal.Zero) {
			return apierror.Validation(spec.itemLabel+"参数不合法",
				map[string][]string{"unitId": {"单位必须是物料默认单位或转换单位"}})
		}
		baseQty = item.Qty.Div(conversion).Round(6)
	}
	var otherCurrency string
	parentColumn := "delivery_id"
	if spec.side == SidePurchase {
		parentColumn = "receipt_id"
	}
	sql := `SELECT order_currency_code FROM ` + spec.itemTable + `
		WHERE ` + parentColumn + `=$1`
	args := []any{parent.ID}
	if excludeItemID != nil {
		sql += ` AND id<>$2`
		args = append(args, *excludeItemID)
	}
	sql += ` ORDER BY idx,id LIMIT 1`
	err = tx.QueryRow(ctx, sql, args...).Scan(&otherCurrency)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return apierror.Wrap(apierror.CodeInternal, "检查履约订单币种失败", err)
	}
	if err == nil && otherCurrency != source.orderCurrencyCode {
		return apierror.Validation(spec.itemLabel+"参数不合法",
			map[string][]string{"orderItemId": {"同一履约单的来源订单原币必须一致"}})
	}
	item.BaseQty = baseQty
	item.CompanyID = parent.CompanyID
	item.MaterialID = source.materialID
	item.UnitID = chosenUnitID
	item.UnitName = unitName
	item.MaterialCode, item.MaterialName = source.materialCode, source.materialName
	item.MaterialSpec, item.CustomerPartNo = source.materialSpec, source.customerPartNo
	item.OrderNo, item.OrderQty, item.OrderBaseQty = source.orderNo, source.orderQty, source.orderBaseQty
	item.OrderUnitName, item.OrderPrice = source.orderUnitName, source.orderPrice
	item.OrderAmount, item.OrderBasePrice = source.orderAmount, source.orderBasePrice
	item.OrderBaseAmount, item.OrderTaxRate = source.orderBaseAmount, source.orderTaxRate
	item.OrderCurrencyCode = source.orderCurrencyCode
	return nil
}

func loadOrderItemSnapshot(
	ctx context.Context, tx pgx.Tx, spec sideSpec, itemID uuid.UUID,
) (orderItemSnapshot, error) {
	var (
		result               orderItemSnapshot
		materialSpec, partNo pgtype.Text
	)
	err := tx.QueryRow(ctx, `SELECT o.id,i.id,o.company_id,o.party_type,o.party_id,o.status,
		o.order_no,cur.iso_code,i.material_id,m.default_unit_id,i.unit_id,i.qty,i.base_qty,
		i.unit_name,i.price,i.amount,i.base_price,i.base_amount,i.tax_rate,
		m.code,m.name,m.spec,m.customer_part_no
		FROM `+spec.orderItemTable+` i
		JOIN `+spec.orderTable+` o ON o.id=i.order_id
		JOIN bas_currency cur ON cur.id=o.currency_id
		JOIN inv_material m ON m.id=i.material_id
		WHERE i.id=$1`, itemID).Scan(
		&result.orderID, &result.orderItemID, &result.companyID, &result.partyType,
		&result.partyID, &result.orderStatus, &result.orderNo, &result.orderCurrencyCode,
		&result.materialID, &result.defaultUnitID, &result.orderUnitID, &result.orderQty,
		&result.orderBaseQty, &result.orderUnitName, &result.orderPrice, &result.orderAmount,
		&result.orderBasePrice, &result.orderBaseAmount, &result.orderTaxRate,
		&result.materialCode, &result.materialName, &materialSpec, &partNo,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return orderItemSnapshot{}, apierror.Validation(spec.itemLabel+"参数不合法",
			map[string][]string{"orderItemId": {"来源订单条目不存在"}})
	}
	if err != nil {
		return orderItemSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取来源订单条目失败", err)
	}
	result.materialSpec, result.customerPartNo = pgconv.TextPtr(materialSpec), pgconv.TextPtr(partNo)
	return result, nil
}

func numericDecimal(value pgtype.Numeric) (decimal.Decimal, bool) {
	if !value.Valid {
		return decimal.Zero, false
	}
	raw, err := value.Value()
	if err != nil || raw == nil {
		return decimal.Zero, false
	}
	result, err := decimal.NewFromString(fmt.Sprint(raw))
	return result, err == nil
}

func findItemParent(
	ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID,
) (uuid.UUID, error) {
	column := "delivery_id"
	if spec.side == SidePurchase {
		column = "receipt_id"
	}
	var parentID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT `+column+` FROM `+spec.itemTable+` WHERE id=$1`, id).Scan(&parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, apierror.New(apierror.CodeNotFound, spec.itemLabel+"不存在")
	}
	if err != nil {
		return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取"+spec.itemLabel+"失败", err)
	}
	return parentID, nil
}

func syncItemDrawings(
	ctx context.Context, tx pgx.Tx, spec sideSpec, itemID, materialID, companyID uuid.UUID,
) error {
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1 AND owner_id=$2`,
		spec.itemOwnerType, itemID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "刷新履约条目图纸失败", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sys_attachment(owner_type,owner_id,category,file_id,company_id)
		SELECT $1,$2,'drawing',file_id,$4 FROM sys_attachment
		WHERE owner_type='inv_material' AND owner_id=$3 AND category='drawing'`,
		spec.itemOwnerType, itemID, materialID, companyID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "复制履约条目图纸失败", err)
	}
	return nil
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "customer_part_no": item.CustomerPartNo,
		"unit_name": item.UnitName, "order_no": item.OrderNo, "order_qty": item.OrderQty,
		"order_base_qty": item.OrderBaseQty, "order_unit_name": item.OrderUnitName,
		"order_price": item.OrderPrice, "order_amount": item.OrderAmount,
		"order_base_price": item.OrderBasePrice, "order_base_amount": item.OrderBaseAmount,
		"order_tax_rate": item.OrderTaxRate, "order_currency_code": item.OrderCurrencyCode,
		"reconciled_qty": item.ReconciledQty, "remarks": item.Remarks,
		"head_id": item.HeadID, "company_id": item.CompanyID, "order_item_id": item.OrderItemID,
		"material_id": item.MaterialID, "unit_id": item.UnitID, "warehouse_id": item.WarehouseID,
	}
}
