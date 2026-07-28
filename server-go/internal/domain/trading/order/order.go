package order

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

var orderAuditFields = []string{
	"order_no", "order_date", "order_type", "is_outsourced", "party_type", "party_id",
	"exchange_rate", "terms", "remarks", "status", "audited_at", "company_id", "currency_id",
	"created_by_id", "audited_by_id",
}

func (s *Service) CreateOrder(
	ctx context.Context, actor *authz.Actor, side Side, input CreateOrderInput,
) (Order, error) {
	spec, err := specFor(side)
	if err != nil {
		return Order{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Order{}, err
	}
	if !actor.CanAccessCompany(input.CompanyID) {
		return Order{}, apierror.New(apierror.CodeForbidden, "无权在该公司下操作数据")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "创建订单失败", err)
	}
	defer tx.Rollback(ctx)
	currencyID, exchangeRate, err := normalizeCurrency(
		ctx, tx, input.CompanyID, input.CurrencyID, input.ExchangeRate,
	)
	if err != nil {
		return Order{}, err
	}
	orderDate := time.Now().UTC()
	if input.OrderDate != nil {
		orderDate = *input.OrderDate
	}
	orderType := input.OrderType
	if orderType == "" {
		orderType = OrderTypeRegular
	}
	orderNo := ""
	if input.OrderNo != nil {
		orderNo = strings.TrimSpace(*input.OrderNo)
	}
	partyType := strings.ToLower(strings.TrimSpace(input.PartyType))
	draft := Order{
		OrderNo: orderNo, OrderDate: orderDate, OrderType: OrderType(strings.ToUpper(string(orderType))),
		IsOutsourced: input.IsOutsourced, PartyType: partyType, PartyID: input.PartyID,
		ExchangeRate: exchangeRate, Terms: input.Terms, Remarks: input.Remarks,
		CompanyID: input.CompanyID, CurrencyID: currencyID,
	}
	if orderNo == "" {
		orderNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: spec.numberResource,
			Values: map[string]any{
				"company_id": input.CompanyID, "order_date": orderDate,
				"order_type": strings.ToLower(string(orderType)), "party_type": partyType,
				"party_id": input.PartyID, "currency_id": currencyID,
			},
		})
		if err != nil {
			return Order{}, err
		}
		draft.OrderNo = orderNo
	}
	if err := validateOrderShape(spec, draft, input.Remarks); err != nil {
		return Order{}, err
	}
	if err := validateParty(ctx, tx, partyType, input.PartyID); err != nil {
		return Order{}, err
	}
	var createdByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	columns := `order_no,order_date,order_type,party_type,party_id,exchange_rate,
		terms,remarks,company_id,currency_id,created_by_id`
	values := `$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11`
	args := []any{
		orderNo, pgconv.DateUTC(orderDate), strings.ToLower(string(orderType)), partyType, input.PartyID,
		exchangeRate, pgconv.Text(input.Terms), pgconv.Text(input.Remarks), input.CompanyID, currencyID, createdByID,
	}
	if side == SidePurchase {
		columns += ",is_outsourced"
		values += ",$12"
		args = append(args, input.IsOutsourced)
	}
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO `+spec.headTable+` (`+columns+
		`) VALUES (`+values+`) RETURNING id`, args...).Scan(&id); err != nil {
		return Order{}, writeError("创建订单失败", err)
	}
	row, err := scanOrderRow(tx.QueryRow(ctx, orderSelect(spec)+" WHERE o.id=$1", id))
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "读取新建订单失败", err)
	}
	result := orderFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.OrderNo,
		"create", "create", result.CompanyID,
		audit.Created(orderSnapshot(result), orderAuditFields)); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Order{}, writeError("创建订单失败", err)
	}
	return result, nil
}

func (s *Service) UpdateOrder(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input UpdateOrderInput,
) (Order, error) {
	spec, err := specFor(side)
	if err != nil {
		return Order{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "更新订单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockOrder(ctx, tx, spec, actor, id)
	if err != nil {
		return Order{}, err
	}
	if locked.Status != "draft" {
		return Order{}, apierror.New(apierror.CodeConflict, "仅草稿订单可修改")
	}
	before := orderFromRow(locked)
	after := before
	if input.OrderNo != nil {
		after.OrderNo = strings.TrimSpace(*input.OrderNo)
	}
	if input.OrderDate != nil {
		after.OrderDate = *input.OrderDate
	}
	if input.OrderType != nil && *input.OrderType != before.OrderType {
		return Order{}, apierror.Validation("订单参数不合法",
			map[string][]string{"orderType": {"订单类型不可变更"}})
	}
	if input.IsOutsourced != nil && *input.IsOutsourced != before.IsOutsourced {
		return Order{}, apierror.Validation("订单参数不合法",
			map[string][]string{"isOutsourced": {"委外标记不可变更"}})
	}
	if input.PartyType != nil {
		after.PartyType = strings.ToUpper(strings.TrimSpace(*input.PartyType))
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.CurrencyID != nil {
		after.CurrencyID = *input.CurrencyID
	}
	if input.ExchangeRate != nil {
		after.ExchangeRate = *input.ExchangeRate
	}
	if input.Terms.Set {
		after.Terms = input.Terms.Value
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	var hasItems bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+spec.itemTable+
		` WHERE order_id=$1)`, id).Scan(&hasItems); err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "检查订单条目失败", err)
	}
	headChanged := after.OrderDate.UTC().Truncate(24*time.Hour) != before.OrderDate.UTC().Truncate(24*time.Hour) ||
		after.PartyType != before.PartyType || after.PartyID != before.PartyID ||
		after.CurrencyID != before.CurrencyID
	if hasItems && headChanged {
		return Order{}, apierror.New(apierror.CodeConflict, "请先删除订单条目")
	}
	currencyInput := (*uuid.UUID)(nil)
	if input.CurrencyID != nil {
		currencyInput = &after.CurrencyID
	}
	rateInput := input.ExchangeRate
	if currencyInput == nil {
		currencyInput = &after.CurrencyID
	}
	rateRequired := input.CurrencyID != nil && after.CurrencyID != before.CurrencyID
	if rateRequired && input.ExchangeRate == nil {
		rateInput = nil
	} else if rateInput == nil {
		rate := after.ExchangeRate
		rateInput = &rate
	}
	after.CurrencyID, after.ExchangeRate, err = normalizeCurrency(
		ctx, tx, after.CompanyID, currencyInput, rateInput,
	)
	if err != nil {
		return Order{}, err
	}
	if err := validateOrderShape(spec, after, after.Remarks); err != nil {
		return Order{}, err
	}
	partyType := strings.ToLower(after.PartyType)
	if err := validateParty(ctx, tx, partyType, after.PartyID); err != nil {
		return Order{}, err
	}
	changes := audit.Diff(orderSnapshot(before), orderSnapshot(after), orderAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Order{}, writeError("更新订单失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.headTable+` SET order_no=$2,order_date=$3,
		party_type=$4,party_id=$5,currency_id=$6,exchange_rate=$7,terms=$8,remarks=$9,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.OrderNo, pgconv.DateUTC(after.OrderDate), partyType, after.PartyID, after.CurrencyID,
		after.ExchangeRate, pgconv.Text(after.Terms), pgconv.Text(after.Remarks))
	if err != nil {
		return Order{}, writeError("更新订单失败", err)
	}
	if !after.ExchangeRate.Equal(before.ExchangeRate) {
		_, err = tx.Exec(ctx, `UPDATE `+spec.itemTable+`
			SET base_price=round(price*$2,4),base_amount=round(amount*$2,2),
			    updated_at=(now() AT TIME ZONE 'utc')
			WHERE order_id=$1`, id, after.ExchangeRate)
		if err != nil {
			return Order{}, apierror.Wrap(apierror.CodeInternal, "重算订单本币金额失败", err)
		}
	}
	row, err := scanOrderRow(tx.QueryRow(ctx, orderSelect(spec)+" WHERE o.id=$1", id))
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "读取更新后订单失败", err)
	}
	result := orderFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.OrderNo,
		"update", "update", result.CompanyID, changes); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Order{}, writeError("更新订单失败", err)
	}
	return result, nil
}

func (s *Service) DeleteOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除订单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockOrder(ctx, tx, spec, actor, id)
	if err != nil {
		return err
	}
	if locked.Status != "draft" {
		return apierror.New(apierror.CodeConflict, "仅草稿订单可删除")
	}
	before := orderFromRow(locked)
	if _, err := tx.Exec(ctx, `DELETE FROM sys_attachment WHERE owner_type=$1 AND owner_id IN
		(SELECT id FROM `+spec.itemTable+` WHERE order_id=$2)`, spec.itemOwnerType, id); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "清理订单条目图纸失败", err)
	}
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, before.OrderNo,
		"destroy", "destroy", before.CompanyID,
		audit.Destroyed(orderSnapshot(before), orderAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.headTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除订单失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除订单失败", err)
	}
	return nil
}

func (s *Service) AuditOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error) {
	return s.transition(ctx, actor, side, id, "audit")
}

func (s *Service) CloseOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error) {
	return s.transition(ctx, actor, side, id, "close")
}

func (s *Service) VoidOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error) {
	return s.transition(ctx, actor, side, id, "void")
}

func (s *Service) transition(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, action string,
) (Order, error) {
	spec, err := specFor(side)
	if err != nil {
		return Order{}, err
	}
	if err := require(actor, spec, action); err != nil {
		return Order{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "变更订单状态失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockOrder(ctx, tx, spec, actor, id)
	if err != nil {
		return Order{}, err
	}
	before := orderFromRow(locked)
	target := ""
	switch action {
	case "audit":
		if locked.Status != "draft" {
			return Order{}, apierror.New(apierror.CodeConflict, "仅草稿订单可审核")
		}
		if err := s.verifyItems(ctx, tx, spec, locked); err != nil {
			return Order{}, err
		}
		if side == SidePurchase {
			if err := verifyAndAdjustDemand(ctx, tx, locked, id, decimal.NewFromInt(1), true); err != nil {
				return Order{}, err
			}
		}
		target = "audited"
	case "close":
		if locked.Status != "audited" {
			return Order{}, apierror.New(apierror.CodeConflict, "仅已审核订单可关闭")
		}
		target = "closed"
	case "void":
		if locked.Status != "audited" {
			return Order{}, apierror.New(apierror.CodeConflict, "仅已审核订单可作废")
		}
		if err := ensureVoidable(ctx, tx, side, id); err != nil {
			return Order{}, err
		}
		if side == SidePurchase {
			if err := verifyAndAdjustDemand(ctx, tx, locked, id, decimal.NewFromInt(-1), false); err != nil {
				return Order{}, err
			}
		}
		target = "voided"
	}
	var auditedAt any
	var auditedBy any
	if action == "audit" {
		auditedAt = time.Now().UTC()
		if actor.UserID != uuid.Nil {
			auditedBy = actor.UserID
		}
	} else {
		auditedAt = locked.AuditedAt
		auditedBy = locked.AuditedByID
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.headTable+`
		SET status=$2,audited_at=$3,audited_by_id=$4,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`, id, target, auditedAt, auditedBy)
	if err != nil {
		return Order{}, writeError("变更订单状态失败", err)
	}
	row, err := scanOrderRow(tx.QueryRow(ctx, orderSelect(spec)+" WHERE o.id=$1", id))
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "读取状态变更后订单失败", err)
	}
	result := orderFromRow(row)
	changes := audit.Diff(orderSnapshot(before), orderSnapshot(result), orderAuditFields)
	if err := writeAudit(ctx, tx, actor, spec.headTable, id, result.OrderNo,
		"update", action, result.CompanyID, changes); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Order{}, writeError("变更订单状态失败", err)
	}
	return result, nil
}

func (s *Service) verifyItems(ctx context.Context, tx pgx.Tx, spec sideSpec, parent orderRow) error {
	rows, err := tx.Query(ctx, `SELECT id FROM `+spec.itemTable+` WHERE order_id=$1 ORDER BY idx,id`, parent.ID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	if len(ids) == 0 {
		return apierror.New(apierror.CodeConflict, "订单至少需要一条条目")
	}
	for _, id := range ids {
		row, err := queryItemByID(ctx, tx, spec, id)
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "复核订单条目失败", err)
		}
		if parent.OrderType == "regular" {
			if row.QuotationItemID == nil {
				return apierror.New(apierror.CodeConflict, "第"+strconv.FormatInt(row.Idx, 10)+"行:缺少报价条目")
			}
			resolved, err := s.quotes.ResolveForOrder(ctx, tx, quotationSide(spec.side), quotation.ResolveOrderInput{
				QuotationItemID: *row.QuotationItemID, OrderDate: dateValue(parent.OrderDate),
				CompanyID: parent.CompanyID, PartyType: parent.PartyType, PartyID: parent.PartyID,
				CurrencyID: parent.CurrencyID, Qty: row.Qty,
			})
			if err != nil {
				return apierror.New(apierror.CodeConflict, "第"+strconv.FormatInt(row.Idx, 10)+"行:"+err.Error())
			}
			if resolved.MaterialID != row.MaterialID || resolved.UnitID != row.UnitID || !resolved.Price.Equal(row.Price) {
				return apierror.New(apierror.CodeConflict, "第"+strconv.FormatInt(row.Idx, 10)+"行:单价或报价派生信息与当前报价不一致")
			}
		} else {
			if row.QuotationItemID != nil {
				return apierror.New(apierror.CodeConflict, "第"+strconv.FormatInt(row.Idx, 10)+"行:非常规订单不得引用报价条目")
			}
			var maximum decimal.Decimal
			if err := tx.QueryRow(ctx, `SELECT `+spec.nonRegularSetting+` FROM sal_setting LIMIT 1`).Scan(&maximum); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "读取订单分型设置失败", err)
			}
			if row.Qty.GreaterThan(maximum) {
				return apierror.New(apierror.CodeConflict, "第"+strconv.FormatInt(row.Idx, 10)+"行:数量超过当前上限")
			}
		}
	}
	return nil
}

func lockOrder(ctx context.Context, tx pgx.Tx, spec sideSpec, actor *authz.Actor, id uuid.UUID) (orderRow, error) {
	row, err := scanOrderRow(tx.QueryRow(ctx, orderSelect(spec)+" WHERE o.id=$1 FOR UPDATE OF o", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return orderRow{}, notFound(spec)
	}
	if err != nil {
		return orderRow{}, apierror.Wrap(apierror.CodeInternal, "锁定订单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return orderRow{}, notFound(spec)
	}
	return row, nil
}

func normalizeCurrency(
	ctx context.Context, tx pgx.Tx, companyID uuid.UUID, currencyID *uuid.UUID,
	exchangeRate *decimal.Decimal,
) (uuid.UUID, decimal.Decimal, error) {
	var baseCurrencyID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT base_currency_id FROM bas_company WHERE id=$1`, companyID).Scan(&baseCurrencyID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, decimal.Zero, apierror.Validation("订单参数不合法",
				map[string][]string{"companyId": {"公司不存在"}})
		}
		return uuid.Nil, decimal.Zero, apierror.Wrap(apierror.CodeInternal, "读取公司本币失败", err)
	}
	chosen := baseCurrencyID
	if currencyID != nil {
		chosen = *currencyID
	}
	if chosen == baseCurrencyID {
		return chosen, decimal.NewFromInt(1), nil
	}
	if exchangeRate == nil {
		return uuid.Nil, decimal.Zero, apierror.Validation("订单参数不合法",
			map[string][]string{"exchangeRate": {"外币订单必须填写汇率"}})
	}
	if !exchangeRate.GreaterThan(decimal.Zero) {
		return uuid.Nil, decimal.Zero, apierror.Validation("订单参数不合法",
			map[string][]string{"exchangeRate": {"必须大于 0"}})
	}
	return chosen, *exchangeRate, nil
}

func ensureVoidable(ctx context.Context, tx pgx.Tx, side Side, orderID uuid.UUID) error {
	var blocked bool
	var query string
	if side == SideSales {
		query = `SELECT EXISTS(
			SELECT 1 FROM sal_delivery_item i JOIN sal_delivery d ON d.id=i.delivery_id
			JOIN sal_order_item oi ON oi.id=i.order_item_id
			WHERE oi.order_id=$1 AND d.status IN ('draft','audited'))`
	} else {
		query = `SELECT EXISTS(
			SELECT 1 FROM pur_receipt_item i JOIN pur_receipt d ON d.id=i.receipt_id
			JOIN pur_order_item oi ON oi.id=i.order_item_id
			WHERE oi.order_id=$1 AND d.status IN ('draft','audited')
			UNION ALL
			SELECT 1 FROM pur_outsourced_receipt_item i
			JOIN pur_outsourced_receipt d ON d.id=i.receipt_id
			JOIN pur_order_item oi ON oi.id=i.order_item_id
			WHERE oi.order_id=$1 AND d.status IN ('draft','audited'))`
	}
	if err := tx.QueryRow(ctx, query, orderID).Scan(&blocked); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查订单下游引用失败", err)
	}
	if blocked {
		return apierror.New(apierror.CodeConflict, "订单存在未删除或已审核的下游单据,不可作废")
	}
	return nil
}

func orderSnapshot(item Order) map[string]any {
	return map[string]any{
		"order_no": item.OrderNo, "order_date": item.OrderDate, "order_type": item.OrderType,
		"is_outsourced": item.IsOutsourced, "party_type": item.PartyType, "party_id": item.PartyID,
		"exchange_rate": item.ExchangeRate, "terms": item.Terms, "remarks": item.Remarks,
		"status": item.Status, "audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"currency_id": item.CurrencyID, "created_by_id": item.CreatedByID, "audited_by_id": item.AuditedByID,
	}
}

func quotationSide(side Side) quotation.Side {
	if side == SidePurchase {
		return quotation.SidePurchase
	}
	return quotation.SideSales
}

func sortedUUIDs[T any](values map[uuid.UUID]T) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for id := range values {
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return strings.Compare(result[i].String(), result[j].String()) < 0 })
	return result
}
