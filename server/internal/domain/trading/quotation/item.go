package quotation

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
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

var itemAuditFields = []string{
	"idx", "pricing_mode", "price", "tax_rate", "material_code", "material_name",
	"material_spec", "customer_part_no", "unit_name", "remarks", "quotation_id",
	"company_id", "material_id", "unit_id",
}

type materialSnapshot struct {
	code, name, unitName string
	spec, customerPartNo *string
	isCustomerMaterial   bool
	customerID           *uuid.UUID
}

func (s *Service) CreateItem(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	input CreateItemInput,
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
		return Item{}, apierror.Wrap(apierror.CodeInternal, "创建报价条目失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockDraftQuotation(ctx, tx, spec, actor, input.QuotationID, "item")
	if err != nil {
		return Item{}, err
	}
	mode, price, taxRate, err := normalizeItemShape(
		input.PricingMode, input.Price, input.TaxRate, input.MaterialID, input.UnitID, input.Remarks,
	)
	if err != nil {
		return Item{}, err
	}
	snapshot, err := loadMaterialSnapshot(ctx, dbgen.New(tx), spec, parent, input.MaterialID, input.UnitID)
	if err != nil {
		return Item{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+spec.itemTable+` (
		idx,pricing_mode,price,tax_rate,material_code,material_name,material_spec,
		customer_part_no,unit_name,remarks,quotation_id,company_id,material_id,unit_id
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
		input.Idx, strings.ToLower(string(mode)), numeric(price), taxRate,
		snapshot.code, snapshot.name, pgconv.Text(snapshot.spec), pgconv.Text(snapshot.customerPartNo),
		snapshot.unitName, pgconv.Text(input.Remarks), input.QuotationID, parent.CompanyID,
		input.MaterialID, input.UnitID,
	).Scan(&id)
	if err != nil {
		return Item{}, writeError("创建报价条目失败", err)
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取新建报价条目失败", err)
	}
	item := itemFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.itemAuditResource, id, strconv.FormatInt(item.Idx, 10),
		"create", "create", item.CompanyID,
		audit.Created(itemSnapshot(item), itemAuditFields)); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("创建报价条目失败", err)
	}
	return item, nil
}

func (s *Service) UpdateItem(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
	input UpdateItemInput,
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
		return Item{}, apierror.Wrap(apierror.CodeInternal, "更新报价条目失败", err)
	}
	defer tx.Rollback(ctx)
	var quotationID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT quotation_id FROM `+spec.itemTable+` WHERE id=$1`, id).Scan(&quotationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, itemNotFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	parent, err := lockDraftQuotation(ctx, tx, spec, actor, quotationID, "item")
	if err != nil {
		return Item{}, err
	}
	beforeRow, err := queryItemByID(ctx, tx, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, itemNotFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	before := itemFromRow(beforeRow)
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.PricingMode != nil {
		after.PricingMode = *input.PricingMode
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
	mode, price, taxRate, err := normalizeItemShape(
		after.PricingMode, after.Price, &after.TaxRate, after.MaterialID, after.UnitID, after.Remarks,
	)
	if err != nil {
		return Item{}, err
	}
	after.PricingMode, after.Price, after.TaxRate = mode, price, taxRate
	snapshot, err := loadMaterialSnapshot(ctx, dbgen.New(tx), spec, parent, after.MaterialID, after.UnitID)
	if err != nil {
		return Item{}, err
	}
	after.MaterialCode, after.MaterialName = snapshot.code, snapshot.name
	after.MaterialSpec, after.CustomerPartNo, after.UnitName =
		snapshot.spec, snapshot.customerPartNo, snapshot.unitName
	changes := audit.Diff(itemSnapshot(before), itemSnapshot(after), itemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Item{}, writeError("更新报价条目失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.itemTable+` SET
		idx=$2,pricing_mode=$3,price=$4,tax_rate=$5,material_code=$6,material_name=$7,
		material_spec=$8,customer_part_no=$9,unit_name=$10,remarks=$11,
		material_id=$12,unit_id=$13,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`,
		id, after.Idx, strings.ToLower(string(after.PricingMode)), numeric(after.Price),
		after.TaxRate, after.MaterialCode, after.MaterialName, pgconv.Text(after.MaterialSpec),
		pgconv.Text(after.CustomerPartNo), after.UnitName, pgconv.Text(after.Remarks),
		after.MaterialID, after.UnitID,
	)
	if err != nil {
		return Item{}, writeError("更新报价条目失败", err)
	}
	if before.PricingMode == PricingQtyTiered && after.PricingMode == PricingFixed {
		if err := purgeTiers(ctx, tx, actor, spec, id); err != nil {
			return Item{}, err
		}
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取更新后报价条目失败", err)
	}
	item := itemFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.itemAuditResource, id, strconv.FormatInt(item.Idx, 10),
		"update", "update", item.CompanyID, changes); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Item{}, writeError("更新报价条目失败", err)
	}
	return item, nil
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
		return apierror.Wrap(apierror.CodeInternal, "删除报价条目失败", err)
	}
	defer tx.Rollback(ctx)
	var quotationID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT quotation_id FROM `+spec.itemTable+` WHERE id=$1`, id).Scan(&quotationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return itemNotFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	if _, err := lockDraftQuotation(ctx, tx, spec, actor, quotationID, "item"); err != nil {
		return err
	}
	row, err := queryItemByID(ctx, tx, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return itemNotFound()
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	item := itemFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.itemAuditResource, id, strconv.FormatInt(item.Idx, 10),
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(itemSnapshot(item), itemAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.itemTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除报价条目失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除报价条目失败", err)
	}
	return nil
}

func normalizeItemShape(
	mode PricingMode,
	price *decimal.Decimal,
	taxRate *decimal.Decimal,
	materialID, unitID uuid.UUID,
	remarks *string,
) (PricingMode, *decimal.Decimal, decimal.Decimal, error) {
	if mode == "" {
		mode = PricingFixed
	}
	mode = PricingMode(strings.ToUpper(strings.TrimSpace(string(mode))))
	rate := decimal.RequireFromString("0.13")
	if taxRate != nil {
		rate = *taxRate
	}
	fields := map[string][]string{}
	switch mode {
	case PricingFixed:
		if price == nil {
			fields["price"] = []string{"固定价条目必须填写含税单价"}
		} else if price.IsNegative() {
			fields["price"] = []string{"含税单价不能为负"}
		}
	case PricingQtyTiered:
		price = nil
	default:
		fields["pricingMode"] = []string{"只能为 FIXED 或 QTY_TIERED"}
	}
	if rate.IsNegative() || rate.GreaterThanOrEqual(decimal.NewFromInt(1)) {
		fields["taxRate"] = []string{"税率必须在 0(含)与 1 之间"}
	}
	if materialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if unitID == uuid.Nil {
		fields["unitId"] = []string{"必填"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return "", nil, decimal.Zero, apierror.Validation("报价条目参数不合法", fields)
	}
	return mode, price, rate, nil
}

func loadMaterialSnapshot(
	ctx context.Context,
	q *dbgen.Queries,
	spec sideSpec,
	parent quotationRow,
	materialID, unitID uuid.UUID,
) (materialSnapshot, error) {
	row, err := q.GetTradingQuotationMaterialSnapshot(ctx, dbgen.GetTradingQuotationMaterialSnapshotParams{
		UnitID: unitID, MaterialID: materialID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, existsErr := q.TradingQuotationMaterialExists(ctx, materialID)
		if existsErr != nil {
			return materialSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取报价物料失败", existsErr)
		}
		if !exists {
			return materialSnapshot{}, apierror.Validation("报价条目参数不合法",
				map[string][]string{"materialId": {"物料不存在"}})
		}
		return materialSnapshot{}, apierror.Validation("报价条目参数不合法",
			map[string][]string{"unitId": {"单位必须是物料默认单位或其单位转换单位"}})
	}
	if err != nil {
		return materialSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取报价物料失败", err)
	}
	if !row.UnitAllowed {
		return materialSnapshot{}, apierror.Validation("报价条目参数不合法",
			map[string][]string{"unitId": {"单位必须是物料默认单位或其单位转换单位"}})
	}
	if spec.customerMaterialGuard && row.IsCustomerMaterial {
		switch {
		case parent.PartyType != "customer":
			return materialSnapshot{}, apierror.Validation("报价条目参数不合法",
				map[string][]string{"materialId": {"客户物料不能挂到内部公司单据"}})
		case row.CustomerID == nil || *row.CustomerID != parent.PartyID:
			return materialSnapshot{}, apierror.Validation("报价条目参数不合法",
				map[string][]string{"materialId": {"非本客户物料,不能挂到此单据"}})
		}
	}
	return materialSnapshot{
		code: row.Code, name: row.Name, unitName: row.UnitName,
		spec: pgconv.TextPtr(row.Spec), customerPartNo: pgconv.TextPtr(row.CustomerPartNo),
		isCustomerMaterial: row.IsCustomerMaterial, customerID: row.CustomerID,
	}, nil
}

func queryItemByID(ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID) (itemRow, error) {
	return scanItemRow(tx.QueryRow(ctx, `SELECT id,idx,pricing_mode,price,tax_rate,
		material_code,material_name,material_spec,customer_part_no,unit_name,remarks,
		inserted_at,updated_at,quotation_id,company_id,material_id,unit_id,tier_count,
		quotation_date,valid_until,quotation_status,party_type,party_id,currency_code,
		quotation_no,company_name,material_live_name,unit_live_name`+
		itemSource(spec)+` WHERE id=$1`, id))
}

func numeric(value *decimal.Decimal) pgtype.Numeric {
	if value == nil {
		return pgtype.Numeric{}
	}
	return pgtype.Numeric{Int: value.Coefficient(), Exp: value.Exponent(), Valid: true}
}

func itemSnapshot(item Item) map[string]any {
	return map[string]any{
		"idx": item.Idx, "pricing_mode": strings.ToLower(string(item.PricingMode)),
		"price": item.Price, "tax_rate": item.TaxRate,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "customer_part_no": item.CustomerPartNo,
		"unit_name": item.UnitName, "remarks": item.Remarks,
		"quotation_id": item.QuotationID, "company_id": item.CompanyID,
		"material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func itemLabel(item Item) string {
	return fmt.Sprintf("%d", item.Idx)
}
