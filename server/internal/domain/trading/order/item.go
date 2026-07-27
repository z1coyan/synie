package order

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// defaultItemTaxRate 是订单条目未显式填写时的默认增值税税率(13%)。
var defaultItemTaxRate = decimal.RequireFromString("0.13")

var itemAuditFields = []string{
	"idx", "qty", "base_qty", "price", "amount", "base_price", "base_amount", "tax_rate",
	"material_code", "material_name", "material_spec", "customer_part_no", "unit_name",
	"remarks", "demand_date", "order_id", "company_id", "material_id", "unit_id",
	"quotation_item_id", "bom_id", "demand_line_id",
}

type materialSnapshot struct {
	code, name, unitName string
	spec, customerPartNo *string
	defaultUnitID        uuid.UUID
	factor               *decimal.Decimal
	isCustomerMaterial   bool
	customerID           *uuid.UUID
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
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建订单条目失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockOrder(ctx, tx, spec, actor, input.OrderID)
	if err != nil {
		return Item{}, err
	}
	if parent.Status != "draft" {
		return Item{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	draft := Item{
		Idx: input.Idx, Qty: input.Qty, MaterialID: input.MaterialID, UnitID: input.UnitID,
		TaxRate: defaultItemTaxRate, Remarks: input.Remarks,
		QuotationItemID: input.QuotationItemID, BOMID: input.BOMID,
		DemandLineID: input.DemandLineID, DemandDate: input.DemandDate,
		OrderID: input.OrderID, CompanyID: parent.CompanyID,
	}
	if input.Price != nil {
		draft.Price = *input.Price
	}
	if input.TaxRate != nil {
		draft.TaxRate = *input.TaxRate
	}
	if err := s.deriveAndValidateItem(ctx, tx, spec, parent, &draft, input.TaxRate != nil); err != nil {
		return Item{}, err
	}
	columns := `idx,qty,base_qty,price,amount,base_price,base_amount,tax_rate,
		material_code,material_name,material_spec,customer_part_no,unit_name,remarks,
		order_id,company_id,material_id,unit_id,quotation_item_id`
	values := `$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19`
	args := []any{
		draft.Idx, draft.Qty, draft.BaseQty, draft.Price, draft.Amount, draft.BasePrice,
		draft.BaseAmount, draft.TaxRate, draft.MaterialCode, draft.MaterialName,
		text(draft.MaterialSpec), text(draft.CustomerPartNo), draft.UnitName, text(draft.Remarks),
		draft.OrderID, draft.CompanyID, draft.MaterialID, draft.UnitID, draft.QuotationItemID,
	}
	if side == SidePurchase {
		columns += ",bom_id,demand_line_id,demand_date"
		values += ",$20,$21,$22"
		args = append(args, draft.BOMID, draft.DemandLineID, nullableDate(draft.DemandDate))
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO `+spec.itemTable+` (`+columns+
		`) VALUES (`+values+`) RETURNING id`, args...).Scan(&id); err != nil {
		return Item{}, writeError("创建订单条目失败", err)
	}
	if err := syncItemDrawings(ctx, tx, spec, id, draft.MaterialID, draft.CompanyID); err != nil {
		return Item{}, err
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取新建订单条目失败", err)
	}
	result := itemFromRow(side, row)
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(result.Idx, 10),
		"create", "create", result.CompanyID,
		audit.Created(itemSnapshot(result), itemAuditFields)); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("创建订单条目失败", err)
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
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新订单条目失败", err)
	}
	defer tx.Rollback(ctx)
	var orderID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_id FROM `+spec.itemTable+` WHERE id=$1`, id).Scan(&orderID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Item{}, itemNotFound()
		}
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	parent, err := lockOrder(ctx, tx, spec, actor, orderID)
	if err != nil {
		var apiErr *apierror.Error
		if errors.As(err, &apiErr) && apiErr.Code == apierror.CodeNotFound {
			return Item{}, itemNotFound()
		}
		return Item{}, err
	}
	if parent.Status != "draft" {
		return Item{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	beforeRow, err := queryItemByID(ctx, tx, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, itemNotFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	before := itemFromRow(side, beforeRow)
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
	if input.Price != nil {
		after.Price = *input.Price
	}
	if input.TaxRate != nil {
		after.TaxRate = *input.TaxRate
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if input.QuotationItemID != nil {
		after.QuotationItemID = *input.QuotationItemID
	}
	if input.BOMID != nil {
		after.BOMID = *input.BOMID
	}
	if input.DemandLineID != nil {
		after.DemandLineID = *input.DemandLineID
	}
	if input.DemandDate != nil {
		after.DemandDate = *input.DemandDate
	}
	if err := s.deriveAndValidateItem(ctx, tx, spec, parent, &after, input.TaxRate != nil); err != nil {
		return Item{}, err
	}
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, writeError("更新订单条目失败", err)
		}
		return before, nil
	}
	sql := `UPDATE ` + spec.itemTable + ` SET idx=$2,qty=$3,base_qty=$4,price=$5,amount=$6,
		base_price=$7,base_amount=$8,tax_rate=$9,material_code=$10,material_name=$11,
		material_spec=$12,customer_part_no=$13,unit_name=$14,remarks=$15,material_id=$16,
		unit_id=$17,quotation_item_id=$18,updated_at=(now() AT TIME ZONE 'utc')`
	args := []any{id, after.Idx, after.Qty, after.BaseQty, after.Price, after.Amount,
		after.BasePrice, after.BaseAmount, after.TaxRate, after.MaterialCode, after.MaterialName,
		text(after.MaterialSpec), text(after.CustomerPartNo), after.UnitName, text(after.Remarks),
		after.MaterialID, after.UnitID, after.QuotationItemID}
	if side == SidePurchase {
		sql += `,bom_id=$19,demand_line_id=$20,demand_date=$21`
		args = append(args, after.BOMID, after.DemandLineID, nullableDate(after.DemandDate))
	}
	sql += " WHERE id=$1"
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return Item{}, writeError("更新订单条目失败", err)
	}
	if err := syncItemDrawings(ctx, tx, spec, id, after.MaterialID, after.CompanyID); err != nil {
		return Item{}, err
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取更新后订单条目失败", err)
	}
	result := itemFromRow(side, row)
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(result.Idx, 10),
		"update", "update", result.CompanyID, changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("更新订单条目失败", err)
	}
	return result, nil
}

func (s *Service) DeleteItem(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除订单条目失败", err)
	}
	defer tx.Rollback(ctx)
	var orderID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_id FROM `+spec.itemTable+` WHERE id=$1`, id).Scan(&orderID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return itemNotFound()
		}
		return apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	parent, err := lockOrder(ctx, tx, spec, actor, orderID)
	if err != nil {
		return itemNotFound()
	}
	if parent.Status != "draft" {
		return apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if err != nil {
		return itemNotFound()
	}
	item := itemFromRow(side, row)
	if err := writeAudit(ctx, tx, actor, spec.itemTable, id, strconv.FormatInt(item.Idx, 10),
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(itemSnapshot(item), itemAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1 AND owner_id=$2`,
		spec.itemOwnerType, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "清理订单条目图纸失败", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.itemTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除订单条目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除订单条目失败", err)
	}
	return nil
}

func (s *Service) deriveAndValidateItem(
	ctx context.Context, tx pgx.Tx, spec sideSpec, parent orderRow, item *Item, taxExplicit bool,
) error {
	fields := map[string][]string{}
	if !item.Qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if item.Remarks != nil && utf8.RuneCountInString(*item.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("订单条目参数不合法", fields)
	}
	if parent.OrderType == "regular" {
		if item.QuotationItemID == nil {
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"quotationItemId": {"常规订单条目必须选择报价条目"}})
		}
		resolved, err := s.quotes.ResolveForOrder(ctx, tx, quotationSide(spec.side), quotation.ResolveOrderInput{
			QuotationItemID: *item.QuotationItemID, OrderDate: dateValue(parent.OrderDate),
			CompanyID: parent.CompanyID, PartyType: parent.PartyType, PartyID: parent.PartyID,
			CurrencyID: parent.CurrencyID, Qty: item.Qty,
		})
		if err != nil {
			return err
		}
		item.MaterialID, item.UnitID, item.Price = resolved.MaterialID, resolved.UnitID, resolved.Price
		if !taxExplicit {
			item.TaxRate = resolved.TaxRate
		}
	} else {
		if item.QuotationItemID != nil {
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"quotationItemId": {"非常规订单不得选择报价条目"}})
		}
		var maximum decimal.Decimal
		if err := tx.QueryRow(ctx, `SELECT `+spec.nonRegularSetting+` FROM sal_setting LIMIT 1`).Scan(&maximum); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取订单分型设置失败", err)
		}
		if item.Qty.GreaterThan(maximum) {
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"qty": {"超过非常规订单单行数量上限"}})
		}
	}
	if item.MaterialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if item.UnitID == uuid.Nil {
		fields["unitId"] = []string{"必填"}
	}
	if item.Price.IsNegative() {
		fields["price"] = []string{"不能小于 0"}
	}
	if item.TaxRate.IsNegative() || item.TaxRate.GreaterThanOrEqual(decimal.NewFromInt(1)) {
		fields["taxRate"] = []string{"必须在 0(含)与 1 之间"}
	}
	if spec.side == SideSales && (item.BOMID != nil || item.DemandLineID != nil || item.DemandDate != nil) {
		fields["orderItem"] = []string{"销售订单条目不支持采购扩展字段"}
	}
	if len(fields) > 0 {
		return apierror.Validation("订单条目参数不合法", fields)
	}
	snapshot, err := loadOrderMaterial(ctx, tx, item.MaterialID, item.UnitID)
	if err != nil {
		return err
	}
	if spec.side == SideSales && snapshot.isCustomerMaterial {
		switch {
		case parent.PartyType != "customer":
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"materialId": {"客户物料不能挂到内部公司单据"}})
		case snapshot.customerID == nil || *snapshot.customerID != parent.PartyID:
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"materialId": {"非本客户物料,不能挂到此单据"}})
		}
	}
	if spec.side == SidePurchase && item.BOMID != nil {
		var materialID uuid.UUID
		err := tx.QueryRow(ctx, `SELECT material_id FROM mfg_bom WHERE id=$1`, *item.BOMID).Scan(&materialID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"bomId": {"BOM 不存在"}})
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取 BOM 失败", err)
		}
		if materialID != item.MaterialID {
			return apierror.Validation("订单条目参数不合法",
				map[string][]string{"bomId": {"BOM 必须是条目物料自身的 BOM"}})
		}
	}
	item.MaterialCode, item.MaterialName = snapshot.code, snapshot.name
	item.MaterialSpec, item.CustomerPartNo, item.UnitName =
		snapshot.spec, snapshot.customerPartNo, snapshot.unitName
	if item.UnitID == snapshot.defaultUnitID {
		item.BaseQty = item.Qty
	} else if snapshot.factor != nil && snapshot.factor.GreaterThan(decimal.Zero) {
		item.BaseQty = item.Qty.Div(*snapshot.factor).Round(6)
	} else {
		return apierror.Validation("订单条目参数不合法",
			map[string][]string{"unitId": {"单位必须是物料默认单位或其单位转换单位"}})
	}
	deriveItemAmounts(item, parent.ExchangeRate)
	return nil
}

// deriveItemAmounts 计算订单条目金额链：金额=数量×单价（2 位）、
// 本币单价=单价×汇率（4 位）、本币金额=金额×汇率（2 位），均按 half-up
// （负数远离零）舍入。该链路是迁移契约金色夹具
// testdata/fixtures/amount_chain.json 的锚点，改动必须同步更新夹具。
func deriveItemAmounts(item *Item, exchangeRate decimal.Decimal) {
	item.Amount = item.Qty.Mul(item.Price).Round(2)
	item.BasePrice = item.Price.Mul(exchangeRate).Round(4)
	item.BaseAmount = item.Amount.Mul(exchangeRate).Round(2)
}

func loadOrderMaterial(
	ctx context.Context, tx pgx.Tx, materialID, unitID uuid.UUID,
) (materialSnapshot, error) {
	var (
		result       materialSnapshot
		spec, partNo pgtype.Text
		factor       pgtype.Numeric
		customerID   *uuid.UUID
	)
	err := tx.QueryRow(ctx, `SELECT m.code,m.name,m.spec,m.customer_part_no,m.default_unit_id,
		m.is_customer_material,m.customer_id,u.name,mu.factor
		FROM inv_material m
		JOIN bas_unit u ON u.id=$2
		LEFT JOIN inv_material_unit mu ON mu.material_id=m.id AND mu.unit_id=u.id
		WHERE m.id=$1`, materialID, unitID).Scan(
		&result.code, &result.name, &spec, &partNo, &result.defaultUnitID,
		&result.isCustomerMaterial, &customerID, &result.unitName, &factor)
	if errors.Is(err, pgx.ErrNoRows) {
		return materialSnapshot{}, apierror.Validation("订单条目参数不合法",
			map[string][]string{"materialId": {"物料或单位不存在"}})
	}
	if err != nil {
		return materialSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取订单物料失败", err)
	}
	result.spec, result.customerPartNo, result.customerID = textPtr(spec), textPtr(partNo), customerID
	if factor.Valid {
		value, valueErr := factor.Value()
		if valueErr == nil && value != nil {
			d, parseErr := decimal.NewFromString(fmt.Sprint(value))
			if parseErr == nil {
				result.factor = &d
			}
		}
	}
	if unitID != result.defaultUnitID && result.factor == nil {
		return materialSnapshot{}, apierror.Validation("订单条目参数不合法",
			map[string][]string{"unitId": {"单位必须是物料默认单位或其单位转换单位"}})
	}
	return result, nil
}

func syncItemDrawings(
	ctx context.Context, tx pgx.Tx, spec sideSpec, itemID, materialID, companyID uuid.UUID,
) error {
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1 AND owner_id=$2`,
		spec.itemOwnerType, itemID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "刷新订单条目图纸失败", err)
	}
	_, err := tx.Exec(ctx, `INSERT INTO sys_attachment(owner_type,owner_id,category,file_id,company_id)
		SELECT $1,$2,'drawing',file_id,$4 FROM sys_attachment
		WHERE owner_type='inv_material' AND owner_id=$3 AND category='drawing'`,
		spec.itemOwnerType, itemID, materialID, companyID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "复制订单条目图纸失败", err)
	}
	return nil
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty, "price": item.Price,
		"amount": item.Amount, "base_price": item.BasePrice, "base_amount": item.BaseAmount,
		"tax_rate": item.TaxRate, "material_code": item.MaterialCode,
		"material_name": item.MaterialName, "material_spec": item.MaterialSpec,
		"customer_part_no": item.CustomerPartNo, "unit_name": item.UnitName,
		"remarks": item.Remarks, "demand_date": item.DemandDate, "order_id": item.OrderID,
		"company_id": item.CompanyID, "material_id": item.MaterialID, "unit_id": item.UnitID,
		"quotation_item_id": item.QuotationItemID, "bom_id": item.BOMID,
		"demand_line_id": item.DemandLineID,
	}
}

func nullableDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return date(*value)
}
