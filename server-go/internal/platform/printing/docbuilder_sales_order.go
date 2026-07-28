package printing

// sales.order 打印装配：一条头查询 + 一条条目查询，键名与打印字段目录
// （meta.Registry 派生）对齐；记录级数据权限按 actor 公司范围 fail-closed
// （对齐 Elixir Ash.get(actor) + CompanyScope 语义：读不到即整批报错）。

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type salesOrderDocBuilder struct {
	pool *pgxpool.Pool
}

func newSalesOrderDocBuilder(pool *pgxpool.Pool) DocBuilder {
	return &salesOrderDocBuilder{pool: pool}
}

func (b *salesOrderDocBuilder) Label() string { return "销售订单" }

func (b *salesOrderDocBuilder) BuildDocs(
	ctx context.Context,
	actor *authz.Actor,
	ids []uuid.UUID,
) ([]BuiltDoc, error) {
	result := make([]BuiltDoc, 0, len(ids))
	for _, id := range ids {
		head, err := b.loadHead(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apierror.New(apierror.CodeNotFound, "部分单据不存在或无权查看")
		}
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取销售订单失败", err)
		}
		if !actor.CanAccessCompany(head.companyID) {
			return nil, apierror.New(apierror.CodeNotFound, "部分单据不存在或无权查看")
		}
		items, err := b.loadItems(ctx, id)
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取销售订单条目失败", err)
		}
		result = append(result, BuiltDoc{SheetName: head.orderNo, Doc: head.toDoc(items)})
	}
	return result, nil
}

type salesOrderHead struct {
	orderNo        string
	orderDate      time.Time
	orderType      string
	partyType      string
	partyID        uuid.UUID
	partyName      *string
	exchangeRate   decimal.Decimal
	terms          *string
	remarks        *string
	status         string
	auditedAt      *time.Time
	companyID      uuid.UUID
	companyCode    string
	companyName    string
	companyShort   string
	currencyISO    string
	currencyName   string
	currencySym    *string
	currencyAct    bool
	creatorName    *string
	creatorUser    *string
	creatorLang    *string
	auditorName    *string
	auditorUser    *string
	auditorLang    *string
	grossTotal     decimal.Decimal
	baseGrossTotal decimal.Decimal
}

func (b *salesOrderDocBuilder) loadHead(ctx context.Context, id uuid.UUID) (*salesOrderHead, error) {
	row := b.pool.QueryRow(ctx, `
SELECT o.order_no,o.order_date,o.order_type,o.party_type,o.party_id,
  CASE o.party_type
    WHEN 'customer' THEN (SELECT name FROM sal_customers WHERE id=o.party_id)
    WHEN 'supplier' THEN (SELECT name FROM pur_supplier WHERE id=o.party_id)
    WHEN 'company' THEN (SELECT name FROM bas_company WHERE id=o.party_id)
    WHEN 'employee' THEN (SELECT name FROM hr_employees WHERE id=o.party_id)
  END AS party_name,
  o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
  o.company_id,c.code,c.name,c.short_name,
  cur.iso_code,cur.name,cur.symbol,cur.active,
  creator.name,creator.username::text,creator.preferred_language,
  auditor.name,auditor.username::text,auditor.preferred_language,
  COALESCE((SELECT sum(i.amount) FROM sal_order_item i WHERE i.order_id=o.id),0) AS gross_total,
  COALESCE((SELECT sum(i.base_amount) FROM sal_order_item i WHERE i.order_id=o.id),0) AS base_gross_total
FROM sal_order o
JOIN bas_company c ON c.id=o.company_id
JOIN bas_currency cur ON cur.id=o.currency_id
LEFT JOIN sys_user creator ON creator.id=o.created_by_id
LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id
WHERE o.id=$1`, id)
	head := &salesOrderHead{}
	err := row.Scan(
		&head.orderNo, &head.orderDate, &head.orderType, &head.partyType, &head.partyID,
		&head.partyName, &head.exchangeRate, &head.terms, &head.remarks, &head.status,
		&head.auditedAt, &head.companyID, &head.companyCode, &head.companyName, &head.companyShort,
		&head.currencyISO, &head.currencyName, &head.currencySym, &head.currencyAct,
		&head.creatorName, &head.creatorUser, &head.creatorLang,
		&head.auditorName, &head.auditorUser, &head.auditorLang,
		&head.grossTotal, &head.baseGrossTotal,
	)
	if err != nil {
		return nil, err
	}
	return head, nil
}

type salesOrderItem struct {
	idx            int64
	qty            decimal.Decimal
	baseQty        decimal.Decimal
	shippedQty     decimal.Decimal
	price          decimal.Decimal
	amount         decimal.Decimal
	basePrice      decimal.Decimal
	baseAmount     decimal.Decimal
	taxRate        decimal.Decimal
	materialCode   string
	materialName   string
	materialSpec   *string
	customerPartNo *string
	unitName       string
	remarks        *string
	materialLive   materialLiveRef
	unit           unitRef
	quotation      quotationItemRef
}

type materialLiveRef struct {
	Code           string
	Name           string
	Spec           *string
	CustomerPartNo *string
	Active         bool
	IsCustomer     bool
}

type unitRef struct {
	Name     string
	Symbol   string
	Ratio    decimal.Decimal
	IsBase   bool
	UnitType string
}

type quotationItemRef struct {
	Idx            *int64
	PricingMode    *string
	Price          *decimal.Decimal
	TaxRate        *decimal.Decimal
	MaterialCode   *string
	MaterialName   *string
	MaterialSpec   *string
	CustomerPartNo *string
	UnitName       *string
	Remarks        *string
}

func (b *salesOrderDocBuilder) loadItems(ctx context.Context, orderID uuid.UUID) ([]salesOrderItem, error) {
	rows, err := b.pool.Query(ctx, `
SELECT i.idx,i.qty,i.base_qty,i.shipped_qty,i.price,i.amount,i.base_price,i.base_amount,
  i.tax_rate,i.material_code,i.material_name,i.material_spec,i.customer_part_no,
  i.unit_name,i.remarks,
  m.code,m.name,m.spec,m.customer_part_no,m.active,m.is_customer_material,
  u.name,u.symbol,u.ratio,u.is_base,u.unit_type,
  qi.idx,qi.pricing_mode,qi.price,qi.tax_rate,qi.material_code,qi.material_name,
  qi.material_spec,qi.customer_part_no,qi.unit_name,qi.remarks
FROM sal_order_item i
JOIN inv_material m ON m.id=i.material_id
JOIN bas_unit u ON u.id=i.unit_id
LEFT JOIN sal_quotation_item qi ON qi.id=i.quotation_item_id
WHERE i.order_id=$1
ORDER BY i.idx,i.id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]salesOrderItem, 0)
	for rows.Next() {
		var item salesOrderItem
		if scanErr := rows.Scan(
			&item.idx, &item.qty, &item.baseQty, &item.shippedQty, &item.price, &item.amount,
			&item.basePrice, &item.baseAmount, &item.taxRate,
			&item.materialCode, &item.materialName, &item.materialSpec, &item.customerPartNo,
			&item.unitName, &item.remarks,
			&item.materialLive.Code, &item.materialLive.Name, &item.materialLive.Spec,
			&item.materialLive.CustomerPartNo, &item.materialLive.Active, &item.materialLive.IsCustomer,
			&item.unit.Name, &item.unit.Symbol, &item.unit.Ratio, &item.unit.IsBase, &item.unit.UnitType,
			&item.quotation.Idx, &item.quotation.PricingMode, &item.quotation.Price,
			&item.quotation.TaxRate, &item.quotation.MaterialCode, &item.quotation.MaterialName,
			&item.quotation.MaterialSpec, &item.quotation.CustomerPartNo,
			&item.quotation.UnitName, &item.quotation.Remarks,
		); scanErr != nil {
			return nil, scanErr
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (h *salesOrderHead) headFields() map[string]string {
	return map[string]string{
		"order_no":                      h.orderNo,
		"order_date":                    formatDate(h.orderDate),
		"order_type":                    enumLabel(salesOrderTypeLabels, h.orderType),
		"party_type":                    enumLabel(partyTypeLabels, h.partyType),
		"party.name":                    formatTextPtr(h.partyName),
		"exchange_rate":                 formatDecimal(h.exchangeRate),
		"terms":                         formatTextPtr(h.terms),
		"remarks":                       formatTextPtr(h.remarks),
		"status":                        enumLabel(salesOrderStatusLabels, h.status),
		"audited_at":                    formatDateTimePtr(h.auditedAt),
		"gross_total":                   formatDecimal(h.grossTotal),
		"base_gross_total":              formatDecimal(h.baseGrossTotal),
		"company.code":                  h.companyCode,
		"company.name":                  h.companyName,
		"company.short_name":            h.companyShort,
		"currency.iso_code":             h.currencyISO,
		"currency.name":                 h.currencyName,
		"currency.symbol":               formatTextPtr(h.currencySym),
		"currency.active":               formatBool(h.currencyAct),
		"created_by.name":               formatTextPtr(h.creatorName),
		"created_by.username":           formatTextPtr(h.creatorUser),
		"created_by.preferred_language": formatTextPtr(h.creatorLang),
		"audited_by.name":               formatTextPtr(h.auditorName),
		"audited_by.username":           formatTextPtr(h.auditorUser),
		"audited_by.preferred_language": formatTextPtr(h.auditorLang),
	}
}

func (h *salesOrderHead) toDoc(items []salesOrderItem) PrintDoc {
	loopRows := make([]map[string]string, 0, len(items))
	for _, item := range items {
		loopRows = append(loopRows, h.itemFields(item))
	}
	return PrintDoc{
		Fields: h.headFields(),
		Loops:  map[string][]map[string]string{"items": loopRows},
	}
}

func (h *salesOrderHead) itemFields(item salesOrderItem) map[string]string {
	return map[string]string{
		"idx":                fmt.Sprintf("%d", item.idx),
		"qty":                formatDecimal(item.qty),
		"base_qty":           formatDecimal(item.baseQty),
		"shipped_qty":        formatDecimal(item.shippedQty),
		"remaining_base_qty": formatDecimal(item.baseQty.Sub(item.shippedQty)),
		"price":              formatDecimal(item.price),
		"amount":             formatDecimal(item.amount),
		"base_price":         formatDecimal(item.basePrice),
		"base_amount":        formatDecimal(item.baseAmount),
		"tax_rate":           formatDecimal(item.taxRate),
		"material_code":      item.materialCode,
		"material_name":      item.materialName,
		"material_spec":      formatTextPtr(item.materialSpec),
		"customer_part_no":   formatTextPtr(item.customerPartNo),
		"unit_name":          item.unitName,
		"remarks":            formatTextPtr(item.remarks),
		// 条目视图的头字段投影（Elixir 计算字段口径）
		"order_date":    formatDate(h.orderDate),
		"order_status":  enumLabel(salesOrderStatusLabels, h.status),
		"party_type":    enumLabel(partyTypeLabels, h.partyType),
		"party_id":      h.partyID.String(),
		"currency_code": h.currencyISO,
		// belongs_to 一层路径
		"company.code":                    h.companyCode,
		"company.name":                    h.companyName,
		"company.short_name":              h.companyShort,
		"material.code":                   item.materialLive.Code,
		"material.name":                   item.materialLive.Name,
		"material.spec":                   formatTextPtr(item.materialLive.Spec),
		"material.customer_part_no":       formatTextPtr(item.materialLive.CustomerPartNo),
		"material.active":                 formatBool(item.materialLive.Active),
		"material.is_customer_material":   formatBool(item.materialLive.IsCustomer),
		"unit.name":                       item.unit.Name,
		"unit.symbol":                     item.unit.Symbol,
		"unit.ratio":                      formatDecimal(item.unit.Ratio),
		"unit.is_base":                    formatBool(item.unit.IsBase),
		"unit.unit_type":                  enumLabel(unitTypeLabels, item.unit.UnitType),
		"order.order_no":                  h.orderNo,
		"order.order_date":                formatDate(h.orderDate),
		"order.order_type":                enumLabel(salesOrderTypeLabels, h.orderType),
		"order.party_type":                enumLabel(partyTypeLabels, h.partyType),
		"order.status":                    enumLabel(salesOrderStatusLabels, h.status),
		"order.terms":                     formatTextPtr(h.terms),
		"order.remarks":                   formatTextPtr(h.remarks),
		"order.exchange_rate":             formatDecimal(h.exchangeRate),
		"order.audited_at":                formatDateTimePtr(h.auditedAt),
		"quotation_item.idx":              formatIntPtr(item.quotation.Idx),
		"quotation_item.pricing_mode":     enumLabel(quotationPricingModeLabels, formatTextPtr(item.quotation.PricingMode)),
		"quotation_item.price":            formatDecimalPtr(item.quotation.Price),
		"quotation_item.tax_rate":         formatDecimalPtr(item.quotation.TaxRate),
		"quotation_item.material_code":    formatTextPtr(item.quotation.MaterialCode),
		"quotation_item.material_name":    formatTextPtr(item.quotation.MaterialName),
		"quotation_item.material_spec":    formatTextPtr(item.quotation.MaterialSpec),
		"quotation_item.customer_part_no": formatTextPtr(item.quotation.CustomerPartNo),
		"quotation_item.unit_name":        formatTextPtr(item.quotation.UnitName),
		"quotation_item.remarks":          formatTextPtr(item.quotation.Remarks),
	}
}

func formatIntPtr(value *int64) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%d", *value)
}
