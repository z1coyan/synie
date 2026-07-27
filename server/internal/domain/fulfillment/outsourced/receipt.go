package outsourced

import (
	"context"
	"errors"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var receiptItemAuditFields = []string{
	"idx", "qty", "base_qty", "material_code", "material_name", "material_spec",
	"customer_part_no", "unit_name", "order_no", "order_qty", "order_base_qty",
	"order_unit_name", "order_price", "order_amount", "order_base_price",
	"order_base_amount", "order_tax_rate", "order_currency_code", "reconciled_qty",
	"remarks", "receipt_id", "company_id", "order_item_id", "material_id", "unit_id",
	"warehouse_id",
}

type receiptOrderSnapshot struct {
	orderID         uuid.UUID
	orderItemID     uuid.UUID
	companyID       uuid.UUID
	partyType       string
	partyID         uuid.UUID
	orderStatus     string
	isOutsourced    bool
	orderNo         string
	currencyCode    string
	materialID      uuid.UUID
	defaultUnitID   uuid.UUID
	orderUnitID     uuid.UUID
	orderQty        decimal.Decimal
	orderBaseQty    decimal.Decimal
	orderUnitName   string
	orderPrice      decimal.Decimal
	orderAmount     decimal.Decimal
	orderBasePrice  decimal.Decimal
	orderBaseAmount decimal.Decimal
	orderTaxRate    decimal.Decimal
	materialCode    string
	materialName    string
	materialSpec    *string
	customerPartNo  *string
}

func (s *Service) CreateReceiptItem(ctx context.Context, actor *authz.Actor, input CreateReceiptItemInput) (ReceiptItem, error) {
	if err := require(actor, receiptPermissionPrefix, "create"); err != nil {
		return ReceiptItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "创建委外入库成品行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockDraftReceipt(ctx, tx, actor, input.ReceiptID)
	if err != nil {
		return ReceiptItem{}, err
	}
	item, err := s.createReceiptItemInTx(ctx, tx, actor, parent, input, true)
	if err != nil {
		return ReceiptItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptItem{}, writeError("创建委外入库成品行", err)
	}
	return item, nil
}

func (s *Service) createReceiptItemInTx(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, parent Receipt,
	input CreateReceiptItemInput, carry bool,
) (ReceiptItem, error) {
	item := ReceiptItem{
		Idx: input.Idx, Qty: input.Qty, ReceiptID: parent.ID,
		OrderItemID: input.OrderItemID, Remarks: input.Remarks,
	}
	if input.WarehouseID != nil {
		item.WarehouseID = *input.WarehouseID
	} else if parent.WarehouseID != nil {
		item.WarehouseID = *parent.WarehouseID
	}
	if err := deriveReceiptItem(ctx, tx, parent, &item, input.UnitID, nil); err != nil {
		return ReceiptItem{}, err
	}
	err := tx.QueryRow(ctx, `INSERT INTO pur_outsourced_receipt_item(
		idx,qty,base_qty,material_code,material_name,material_spec,customer_part_no,
		unit_name,order_no,order_qty,order_base_qty,order_unit_name,order_price,
		order_amount,order_base_price,order_base_amount,order_tax_rate,
		order_currency_code,reconciled_qty,remarks,receipt_id,company_id,order_item_id,
		material_id,unit_id,warehouse_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
		0,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
		item.Idx, item.Qty, item.BaseQty, item.MaterialCode, item.MaterialName,
		pgconv.Text(item.MaterialSpec), pgconv.Text(item.CustomerPartNo), item.UnitName, item.OrderNo,
		item.OrderQty, item.OrderBaseQty, item.OrderUnitName, item.OrderPrice,
		item.OrderAmount, item.OrderBasePrice, item.OrderBaseAmount, item.OrderTaxRate,
		item.OrderCurrencyCode, pgconv.Text(item.Remarks), item.ReceiptID, item.CompanyID,
		item.OrderItemID, item.MaterialID, item.UnitID, item.WarehouseID).Scan(&item.ID)
	if err != nil {
		return ReceiptItem{}, writeError("创建委外入库成品行", err)
	}
	result, err := queryReceiptItem(ctx, tx, item.ID, false)
	if err != nil {
		return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外入库成品行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptItemTable, result.ID,
		strconv.FormatInt(result.Idx, 10), "create", "create", result.CompanyID,
		audit.Created(receiptItemSnapshot(result), receiptItemAuditFields)); err != nil {
		return ReceiptItem{}, err
	}
	if carry && result.OrderBaseQty.GreaterThan(decimal.Zero) {
		if err := s.carryReceiptChildren(ctx, tx, actor, parent, result); err != nil {
			return ReceiptItem{}, err
		}
	}
	return result, nil
}

func (s *Service) UpdateReceiptItem(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateReceiptItemInput) (ReceiptItem, error) {
	if err := require(actor, receiptPermissionPrefix, "update"); err != nil {
		return ReceiptItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "更新委外入库成品行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=$1`, id).Scan(&parentID); err != nil {
		return ReceiptItem{}, apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	parent, err := lockDraftReceipt(ctx, tx, actor, parentID)
	if err != nil {
		return ReceiptItem{}, err
	}
	before, err := queryReceiptItem(ctx, tx, id, false)
	if err != nil {
		return ReceiptItem{}, apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
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
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if after.OrderItemID != before.OrderItemID {
		var children bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM pur_outsourced_receipt_item_material WHERE receipt_item_id=$1
			UNION ALL SELECT 1 FROM pur_outsourced_receipt_item_byproduct WHERE receipt_item_id=$1
		)`, id).Scan(&children); err != nil {
			return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "检查委外入库子行失败", err)
		}
		if children {
			return ReceiptItem{}, apierror.New(apierror.CodeConflict, "已有材料或副产物行时不可更换来源订单行")
		}
	}
	var unitID *uuid.UUID
	if input.UnitID != nil {
		unitID = *input.UnitID
	} else {
		unitID = &after.UnitID
	}
	if err := deriveReceiptItem(ctx, tx, parent, &after, unitID, &id); err != nil {
		return ReceiptItem{}, err
	}
	changes := audit.Diff(receiptItemSnapshot(before), receiptItemSnapshot(after), receiptItemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return ReceiptItem{}, writeError("更新委外入库成品行", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_receipt_item SET idx=$2,qty=$3,
		base_qty=$4,material_code=$5,material_name=$6,material_spec=$7,
		customer_part_no=$8,unit_name=$9,order_no=$10,order_qty=$11,
		order_base_qty=$12,order_unit_name=$13,order_price=$14,order_amount=$15,
		order_base_price=$16,order_base_amount=$17,order_tax_rate=$18,
		order_currency_code=$19,remarks=$20,order_item_id=$21,material_id=$22,
		unit_id=$23,warehouse_id=$24,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.Qty, after.BaseQty, after.MaterialCode, after.MaterialName,
		pgconv.Text(after.MaterialSpec), pgconv.Text(after.CustomerPartNo), after.UnitName, after.OrderNo,
		after.OrderQty, after.OrderBaseQty, after.OrderUnitName, after.OrderPrice,
		after.OrderAmount, after.OrderBasePrice, after.OrderBaseAmount, after.OrderTaxRate,
		after.OrderCurrencyCode, pgconv.Text(after.Remarks), after.OrderItemID, after.MaterialID,
		after.UnitID, after.WarehouseID)
	if err != nil {
		return ReceiptItem{}, writeError("更新委外入库成品行", err)
	}
	result, err := queryReceiptItem(ctx, tx, id, false)
	if err != nil {
		return ReceiptItem{}, apierror.Wrap(apierror.CodeInternal, "读取更新后委外入库成品行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptItemTable, id,
		strconv.FormatInt(result.Idx, 10), "update", "update", result.CompanyID, changes); err != nil {
		return ReceiptItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReceiptItem{}, writeError("更新委外入库成品行", err)
	}
	return result, nil
}

func (s *Service) DeleteReceiptItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, receiptPermissionPrefix, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除委外入库成品行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT receipt_id FROM pur_outsourced_receipt_item WHERE id=$1`, id).Scan(&parentID); err != nil {
		return apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	if _, err := lockDraftReceipt(ctx, tx, actor, parentID); err != nil {
		return err
	}
	item, err := queryReceiptItem(ctx, tx, id, false)
	if err != nil {
		return apierror.New(apierror.CodeNotFound, "委外入库成品行不存在")
	}
	if err := writeAudit(ctx, tx, actor, receiptItemTable, id,
		strconv.FormatInt(item.Idx, 10), "destroy", "destroy", item.CompanyID,
		audit.Destroyed(receiptItemSnapshot(item), receiptItemAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_outsourced_receipt_item WHERE id=$1`, id); err != nil {
		return writeError("删除委外入库成品行", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除委外入库成品行", err)
	}
	return nil
}

func deriveReceiptItem(ctx context.Context, tx pgx.Tx, parent Receipt, item *ReceiptItem, unitID *uuid.UUID, excludeID *uuid.UUID) error {
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
		return apierror.Validation("委外入库成品行参数不合法", fields)
	}
	if err := validateWarehouse(ctx, tx, parent.CompanyID, item.WarehouseID); err != nil {
		return err
	}
	source, err := loadReceiptOrderSnapshot(ctx, tx, item.OrderItemID)
	if err != nil {
		return err
	}
	if source.orderStatus != "audited" || !source.isOutsourced {
		return apierror.Validation("委外入库成品行参数不合法", map[string][]string{"orderItemId": {"来源须为已审核委外订单行"}})
	}
	if source.companyID != parent.CompanyID || source.partyType != parent.PartyType || source.partyID != parent.PartyID {
		return apierror.Validation("委外入库成品行参数不合法", map[string][]string{"orderItemId": {"来源订单公司或对手不一致"}})
	}
	chosenUnit := source.orderUnitID
	if unitID != nil && *unitID != uuid.Nil {
		chosenUnit = *unitID
	}
	baseQty, unitName, err := deriveBaseQty(ctx, tx, source.materialID, source.defaultUnitID, chosenUnit, item.Qty)
	if err != nil {
		return err
	}
	sql, args := `SELECT order_currency_code FROM pur_outsourced_receipt_item
		WHERE receipt_id=$1`, []any{parent.ID}
	if excludeID != nil {
		sql += ` AND id<>$2`
		args = append(args, *excludeID)
	}
	sql += ` ORDER BY idx,id LIMIT 1`
	var currency string
	err = tx.QueryRow(ctx, sql, args...).Scan(&currency)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return apierror.Wrap(apierror.CodeInternal, "检查委外入库订单币种失败", err)
	}
	if err == nil && currency != source.currencyCode {
		return apierror.Validation("委外入库成品行参数不合法", map[string][]string{"orderItemId": {"同一入库单来源订单原币必须一致"}})
	}
	item.BaseQty, item.CompanyID = baseQty, parent.CompanyID
	item.MaterialID, item.UnitID, item.UnitName = source.materialID, chosenUnit, unitName
	item.MaterialCode, item.MaterialName = source.materialCode, source.materialName
	item.MaterialSpec, item.CustomerPartNo = source.materialSpec, source.customerPartNo
	item.OrderNo, item.OrderQty, item.OrderBaseQty = source.orderNo, source.orderQty, source.orderBaseQty
	item.OrderUnitName, item.OrderPrice, item.OrderAmount = source.orderUnitName, source.orderPrice, source.orderAmount
	item.OrderBasePrice, item.OrderBaseAmount = source.orderBasePrice, source.orderBaseAmount
	item.OrderTaxRate, item.OrderCurrencyCode = source.orderTaxRate, source.currencyCode
	return nil
}

func loadReceiptOrderSnapshot(ctx context.Context, tx pgx.Tx, id uuid.UUID) (receiptOrderSnapshot, error) {
	var result receiptOrderSnapshot
	var spec, partNo pgtype.Text
	err := tx.QueryRow(ctx, `SELECT o.id,i.id,o.company_id,o.party_type,o.party_id,o.status,
		o.is_outsourced,o.order_no,cur.iso_code,i.material_id,m.default_unit_id,i.unit_id,
		i.qty,i.base_qty,i.unit_name,i.price,i.amount,i.base_price,i.base_amount,i.tax_rate,
		m.code,m.name,m.spec,m.customer_part_no
		FROM pur_order_item i JOIN pur_order o ON o.id=i.order_id
		JOIN bas_currency cur ON cur.id=o.currency_id
		JOIN inv_material m ON m.id=i.material_id WHERE i.id=$1`, id).Scan(
		&result.orderID, &result.orderItemID, &result.companyID, &result.partyType,
		&result.partyID, &result.orderStatus, &result.isOutsourced, &result.orderNo,
		&result.currencyCode, &result.materialID, &result.defaultUnitID,
		&result.orderUnitID, &result.orderQty, &result.orderBaseQty,
		&result.orderUnitName, &result.orderPrice, &result.orderAmount,
		&result.orderBasePrice, &result.orderBaseAmount, &result.orderTaxRate,
		&result.materialCode, &result.materialName, &spec, &partNo)
	if errors.Is(err, pgx.ErrNoRows) {
		return receiptOrderSnapshot{}, apierror.Validation("委外入库成品行参数不合法", map[string][]string{"orderItemId": {"来源订单行不存在"}})
	}
	if err != nil {
		return receiptOrderSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取委外订单行快照失败", err)
	}
	result.materialSpec, result.customerPartNo = pgconv.TextPtr(spec), pgconv.TextPtr(partNo)
	return result, nil
}

func (s *Service) AuditReceipt(ctx context.Context, actor *authz.Actor, id uuid.UUID, input AuditReceiptInput) (Receipt, error) {
	if err := require(actor, receiptPermissionPrefix, "audit"); err != nil {
		return Receipt{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "审核委外入库单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockDraftReceipt(ctx, tx, actor, id)
	if err != nil {
		return Receipt{}, err
	}
	items, materials, byproducts, err := loadReceiptActionLines(ctx, tx, id)
	if err != nil {
		return Receipt{}, err
	}
	if len(items) == 0 {
		return Receipt{}, apierror.New(apierror.CodeConflict, "委外入库单至少需要一条成品行")
	}
	requireOutsourced := true
	projection := make([]order.FulfillmentLine, 0, len(items))
	stockLines := make([]stock.Line, 0, len(items)+len(materials)+len(byproducts))
	amount := decimal.Zero
	for _, item := range items {
		check := item
		if err := deriveReceiptItem(ctx, tx, before, &check, &item.UnitID, &item.ID); err != nil {
			return Receipt{}, err
		}
		projection = append(projection, order.FulfillmentLine{OrderItemID: item.OrderItemID, BaseQty: item.BaseQty})
		stockLines = append(stockLines, stock.Line{WarehouseID: item.WarehouseID, MaterialID: item.MaterialID, Quantity: item.BaseQty, Remarks: item.Remarks})
		if item.OrderBaseQty.GreaterThan(decimal.Zero) {
			amount = amount.Add(item.OrderBaseAmount.Mul(item.BaseQty).Div(item.OrderBaseQty))
		}
	}
	for _, item := range materials {
		if item.OutsourcedWarehouseID == nil {
			return Receipt{}, apierror.New(apierror.CodeConflict, "材料扣减行必须填写外协仓")
		}
		if err := validateOutsourcedWarehouse(ctx, tx, before.CompanyID, before.PartyType, before.PartyID, *item.OutsourcedWarehouseID); err != nil {
			return Receipt{}, err
		}
		stockLines = append(stockLines, stock.Line{WarehouseID: *item.OutsourcedWarehouseID, MaterialID: item.MaterialID, Quantity: item.BaseQty.Neg(), Remarks: item.Remarks})
	}
	for _, item := range byproducts {
		if item.WarehouseID == nil {
			return Receipt{}, apierror.New(apierror.CodeConflict, "副产物行必须填写入仓")
		}
		if err := validateWarehouse(ctx, tx, before.CompanyID, *item.WarehouseID); err != nil {
			return Receipt{}, err
		}
		stockLines = append(stockLines, stock.Line{WarehouseID: *item.WarehouseID, MaterialID: item.MaterialID, Quantity: item.BaseQty, Remarks: item.Remarks})
	}
	if err := s.orders.PostFulfillment(ctx, tx, order.SidePurchase, order.FulfillmentInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		RequireOutsourced: &requireOutsourced, Lines: projection,
	}); err != nil {
		return Receipt{}, err
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "purchase.outsourced_receipt", ID: id, No: before.ReceiptNo,
		CompanyID: before.CompanyID, PostingDate: before.ReceiptDate,
	}, stockLines); err != nil {
		return Receipt{}, err
	}
	postingDate := before.ReceiptDate
	if before.PostingDate != nil {
		postingDate = *before.PostingDate
	}
	if input.PostingDate != nil {
		postingDate = *input.PostingDate
	}
	amount = amount.Round(2)
	if amount.GreaterThan(decimal.Zero) {
		if postingDate.IsZero() {
			return Receipt{}, apierror.Validation("审核委外入库单参数不合法", map[string][]string{"postingDate": {"有金额过账时必填"}})
		}
		debitCurrency, creditCurrency, err := accountCurrencies(ctx, tx, before.DebitAccountID, before.CreditAccountID)
		if err != nil {
			return Receipt{}, err
		}
		partyType, partyID := before.PartyType, before.PartyID
		if err := gl.Post(ctx, tx, gl.Voucher{
			Type: "purchase.outsourced_receipt", ID: id, No: before.ReceiptNo,
			CompanyID: before.CompanyID, PostingDate: postingDate,
		}, []gl.Entry{
			{AccountID: before.DebitAccountID, CurrencyID: debitCurrency, Debit: amount, Credit: decimal.Zero},
			{AccountID: before.CreditAccountID, CurrencyID: creditCurrency, Debit: decimal.Zero, Credit: amount, PartyType: &partyType, PartyID: &partyID},
		}); err != nil {
			return Receipt{}, err
		}
	}
	now := time.Now().UTC()
	var auditedBy *uuid.UUID
	if actor.UserID != uuid.Nil {
		auditedBy = &actor.UserID
	}
	if _, err := tx.Exec(ctx, `UPDATE pur_outsourced_receipt SET status='audited',
		posting_date=$2,audited_at=$3,audited_by_id=$4,updated_at=$3 WHERE id=$1`,
		id, pgconv.Date(postingDate), pgconv.Timestamp(now), auditedBy); err != nil {
		return Receipt{}, writeError("审核委外入库单", err)
	}
	result, err := queryReceipt(ctx, tx, id, false)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "读取审核后委外入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptTable, id, result.ReceiptNo,
		"update", "audit", result.CompanyID,
		audit.Diff(receiptSnapshot(before), receiptSnapshot(result), receiptAuditFields)); err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, writeError("审核委外入库单", err)
	}
	return result, nil
}

func (s *Service) VoidReceipt(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Receipt, error) {
	if err := require(actor, receiptPermissionPrefix, "void"); err != nil {
		return Receipt{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "作废委外入库单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockReceipt(ctx, tx, actor, id)
	if err != nil {
		return Receipt{}, err
	}
	if before.Status != StatusAudited {
		return Receipt{}, apierror.New(apierror.CodeConflict, "仅已审核委外入库单可作废")
	}
	items, _, _, err := loadReceiptActionLines(ctx, tx, id)
	if err != nil {
		return Receipt{}, err
	}
	projection := make([]order.FulfillmentLine, 0, len(items))
	for _, item := range items {
		if item.ReconciledQty.GreaterThan(decimal.Zero) {
			return Receipt{}, apierror.New(apierror.CodeConflict, "存在已对账成品行,不可作废")
		}
		projection = append(projection, order.FulfillmentLine{OrderItemID: item.OrderItemID, BaseQty: item.BaseQty})
	}
	requireOutsourced := true
	if err := s.orders.ReverseFulfillment(ctx, tx, order.SidePurchase, order.FulfillmentInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		RequireOutsourced: &requireOutsourced, Lines: projection,
	}); err != nil {
		return Receipt{}, err
	}
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{
		Type: "purchase.outsourced_receipt", ID: id,
	}, time.Now().UTC()); err != nil {
		return Receipt{}, err
	}
	if err := gl.Cancel(ctx, tx, gl.VoucherRef{Type: "purchase.outsourced_receipt", ID: id}); err != nil {
		return Receipt{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE pur_outsourced_receipt SET status='voided',
		updated_at=$2 WHERE id=$1`, id, pgconv.Timestamp(now)); err != nil {
		return Receipt{}, writeError("作废委外入库单", err)
	}
	result, err := queryReceipt(ctx, tx, id, false)
	if err != nil {
		return Receipt{}, apierror.Wrap(apierror.CodeInternal, "读取作废后委外入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, receiptTable, id, result.ReceiptNo,
		"update", "void", result.CompanyID,
		audit.Diff(receiptSnapshot(before), receiptSnapshot(result), receiptAuditFields)); err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, writeError("作废委外入库单", err)
	}
	return result, nil
}

func loadReceiptActionLines(ctx context.Context, tx pgx.Tx, id uuid.UUID) ([]ReceiptItem, []ReceiptMaterial, []ReceiptByproduct, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM pur_outsourced_receipt_item WHERE receipt_id=$1 ORDER BY id`, id)
	if err != nil {
		return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库成品行失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库成品行失败", err)
		}
		ids = append(ids, itemID)
	}
	rows.Close()
	items := make([]ReceiptItem, 0, len(ids))
	var materials []ReceiptMaterial
	var byproducts []ReceiptByproduct
	for _, itemID := range ids {
		item, err := queryReceiptItem(ctx, tx, itemID, false)
		if err != nil {
			return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库成品行失败", err)
		}
		items = append(items, item)
		childRows, err := tx.Query(ctx, `SELECT id,'material' FROM pur_outsourced_receipt_item_material WHERE receipt_item_id=$1
			UNION ALL SELECT id,'byproduct' FROM pur_outsourced_receipt_item_byproduct WHERE receipt_item_id=$1
			ORDER BY 1`, itemID)
		if err != nil {
			return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库子行失败", err)
		}
		type childRef struct {
			id   uuid.UUID
			kind string
		}
		refs := make([]childRef, 0)
		for childRows.Next() {
			var ref childRef
			if err := childRows.Scan(&ref.id, &ref.kind); err != nil {
				childRows.Close()
				return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库子行失败", err)
			}
			refs = append(refs, ref)
		}
		if err := childRows.Err(); err != nil {
			childRows.Close()
			return nil, nil, nil, apierror.Wrap(apierror.CodeInternal, "遍历委外入库子行失败", err)
		}
		childRows.Close()
		for _, ref := range refs {
			if ref.kind == "material" {
				child, err := queryReceiptMaterial(ctx, tx, ref.id, false)
				if err != nil {
					return nil, nil, nil, err
				}
				materials = append(materials, child)
			} else {
				child, err := queryReceiptByproduct(ctx, tx, ref.id, false)
				if err != nil {
					return nil, nil, nil, err
				}
				byproducts = append(byproducts, child)
			}
		}
	}
	return items, materials, byproducts, nil
}

func accountCurrencies(ctx context.Context, tx pgx.Tx, debitID, creditID uuid.UUID) (*uuid.UUID, *uuid.UUID, error) {
	result := map[uuid.UUID]*uuid.UUID{}
	rows, err := tx.Query(ctx, `SELECT id,currency_id FROM bas_account WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{debitID, creditID})
	if err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取委外入库科目币种失败", err)
	}
	for rows.Next() {
		var id uuid.UUID
		var currency *uuid.UUID
		if err := rows.Scan(&id, &currency); err != nil {
			rows.Close()
			return nil, nil, err
		}
		result[id] = currency
	}
	rows.Close()
	return result[debitID], result[creditID], nil
}

func receiptItemSnapshot(item ReceiptItem) map[string]any {
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
		"receipt_id": item.ReceiptID, "company_id": item.CompanyID,
		"order_item_id": item.OrderItemID, "material_id": item.MaterialID,
		"unit_id": item.UnitID, "warehouse_id": item.WarehouseID,
	}
}
