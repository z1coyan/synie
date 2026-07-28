package quotation

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

// ResolveOrderInput is the transaction-local context required to turn a quotation
// item into an order price. Callers must already hold the target order head lock.
type ResolveOrderInput struct {
	QuotationItemID uuid.UUID
	OrderDate       time.Time
	CompanyID       uuid.UUID
	PartyType       string
	PartyID         uuid.UUID
	CurrencyID      uuid.UUID
	Qty             decimal.Decimal
}

type ResolveOrderResult struct {
	MaterialID uuid.UUID
	UnitID     uuid.UUID
	Price      decimal.Decimal
	TaxRate    decimal.Decimal
}

// ResolveForOrder owns quotation validity and tier selection. The quotation head
// lock serializes this read with quotation item/tier edits and voiding.
func (s *Service) ResolveForOrder(
	ctx context.Context,
	tx pgx.Tx,
	side Side,
	input ResolveOrderInput,
) (ResolveOrderResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return ResolveOrderResult{}, err
	}
	var (
		materialID, unitID, companyID, partyID, currencyID uuid.UUID
		quotationDate, validUntil                          pgtype.Date
		partyType, status, pricingMode                     string
		fixedPrice                                         pgtype.Numeric
		taxRate                                            decimal.Decimal
	)
	err = tx.QueryRow(ctx, `SELECT i.material_id,i.unit_id,i.pricing_mode,i.price,i.tax_rate,
		q.quotation_date,q.valid_until,q.status,q.company_id,q.party_type,q.party_id,q.currency_id
		FROM `+spec.itemTable+` i
		JOIN `+spec.headTable+` q ON q.id=i.quotation_id
		WHERE i.id=$1
		FOR UPDATE OF q`, input.QuotationItemID).Scan(
		&materialID, &unitID, &pricingMode, &fixedPrice, &taxRate,
		&quotationDate, &validUntil, &status, &companyID, &partyType, &partyID, &currencyID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResolveOrderResult{}, apierror.Validation("订单条目参数不合法",
			map[string][]string{"quotationItemId": {"报价条目不存在"}})
	}
	if err != nil {
		return ResolveOrderResult{}, apierror.Wrap(apierror.CodeInternal, "解析订单报价失败", err)
	}
	orderDate := input.OrderDate.UTC().Truncate(24 * time.Hour)
	if status != "audited" {
		return ResolveOrderResult{}, quoteConflict("报价单须为已审核状态")
	}
	if orderDate.Before(quotationDate.Time.UTC()) || orderDate.After(validUntil.Time.UTC()) {
		return ResolveOrderResult{}, quoteConflict("订单日期不在报价有效期内")
	}
	if companyID != input.CompanyID {
		return ResolveOrderResult{}, quoteConflict("报价公司与订单不一致")
	}
	if partyType != strings.ToLower(strings.TrimSpace(input.PartyType)) || partyID != input.PartyID {
		return ResolveOrderResult{}, quoteConflict("报价对手与订单不一致")
	}
	if currencyID != input.CurrencyID {
		return ResolveOrderResult{}, quoteConflict("报价币种与订单不一致")
	}
	result := ResolveOrderResult{MaterialID: materialID, UnitID: unitID, TaxRate: taxRate}
	switch pricingMode {
	case "fixed":
		price := decimalPtr(fixedPrice)
		if price == nil {
			return ResolveOrderResult{}, quoteConflict("固定价报价缺少单价")
		}
		result.Price = *price
	case "qty_tiered":
		err = tx.QueryRow(ctx, `SELECT price FROM `+spec.tierTable+
			` WHERE item_id=$1 AND min_qty <= $2 ORDER BY min_qty DESC LIMIT 1`,
			input.QuotationItemID, input.Qty).Scan(&result.Price)
		if errors.Is(err, pgx.ErrNoRows) {
			return ResolveOrderResult{}, quoteConflict("数量低于首档起订量,无可用报价")
		}
		if err != nil {
			return ResolveOrderResult{}, apierror.Wrap(apierror.CodeInternal, "解析数量梯度报价失败", err)
		}
	default:
		return ResolveOrderResult{}, quoteConflict("报价定价模式不合法")
	}
	return result, nil
}

func quoteConflict(message string) error {
	return apierror.New(apierror.CodeConflict, message)
}
