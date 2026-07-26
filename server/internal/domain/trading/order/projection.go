package order

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

// FulfillmentLine is a source-document quantity expressed in the material's
// default unit. Callers may supply several lines for the same order item; this
// module groups them before checking the current projection and tolerance.
type FulfillmentLine struct {
	OrderItemID uuid.UUID
	BaseQty     decimal.Decimal
}

// FulfillmentInput carries the invariants owned by a fulfillment aggregate.
// RequireOutsourced is nil for standard receipts because the legacy contract
// intentionally allows both regular and outsourced purchase orders.
type FulfillmentInput struct {
	CompanyID         uuid.UUID
	PartyType         string
	PartyID           uuid.UUID
	RequireOutsourced *bool
	Lines             []FulfillmentLine
}

// OutsourcedIssueLine is a material-list projection written by an outsourced
// issue. The quantity is expressed in the material's default unit.
type OutsourcedIssueLine struct {
	OrderItemMaterialID uuid.UUID
	BaseQty             decimal.Decimal
}

type OutsourcedIssueInput struct {
	CompanyID uuid.UUID
	PartyType string
	PartyID   uuid.UUID
	Lines     []OutsourcedIssueLine
}

type lockedProjectionOrder struct {
	status       string
	isOutsourced bool
	companyID    uuid.UUID
	partyType    string
	partyID      uuid.UUID
}

// PostFulfillment validates and increments shipped/received projections inside
// the caller-owned transaction. Locks are always acquired order-head first,
// then order-item, then demand-item, with UUIDs sorted within each group.
func (s *Service) PostFulfillment(
	ctx context.Context,
	tx pgx.Tx,
	side Side,
	input FulfillmentInput,
) error {
	return s.adjustFulfillment(ctx, tx, side, input, decimal.NewFromInt(1), true)
}

// ReverseFulfillment decrements projections for a voided downstream document.
// It deliberately does not require the order to remain AUDITED: an already
// closed order must still permit correction of its historical fulfillment.
func (s *Service) ReverseFulfillment(
	ctx context.Context,
	tx pgx.Tx,
	side Side,
	input FulfillmentInput,
) error {
	return s.adjustFulfillment(ctx, tx, side, input, decimal.NewFromInt(-1), false)
}

func (s *Service) adjustFulfillment(
	ctx context.Context,
	tx pgx.Tx,
	side Side,
	input FulfillmentInput,
	direction decimal.Decimal,
	verify bool,
) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	grouped, err := groupFulfillmentLines(input.Lines)
	if err != nil {
		return err
	}
	orders, itemOrders, err := lockProjectionOrders(
		ctx, tx, spec, fulfillmentItemIDs(grouped),
	)
	if err != nil {
		return err
	}
	if err := validateProjectionOrders(orders, input, verify); err != nil {
		return err
	}

	ratio := decimal.Zero
	if verify {
		column := "delivery_overship_ratio"
		if side == SidePurchase {
			column = "receipt_overreceive_ratio"
		}
		if err := tx.QueryRow(ctx, `SELECT `+column+` FROM sal_setting LIMIT 1`).Scan(&ratio); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取履约容差失败", err)
		}
	}

	projectionColumn := "shipped_qty"
	if side == SidePurchase {
		projectionColumn = "received_qty"
	}
	demandDeltas := make(map[uuid.UUID]decimal.Decimal)
	for _, itemID := range sortedUUIDs(grouped) {
		var (
			orderID    uuid.UUID
			baseQty    decimal.Decimal
			projected  decimal.Decimal
			demandLine *uuid.UUID
		)
		demandSelect := "NULL::uuid"
		if side == SidePurchase {
			demandSelect = "demand_line_id"
		}
		err := tx.QueryRow(ctx, `SELECT order_id,base_qty,`+projectionColumn+`,`+
			demandSelect+` FROM `+spec.itemTable+` WHERE id=$1 FOR UPDATE`,
			itemID,
		).Scan(&orderID, &baseQty, &projected, &demandLine)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.New(apierror.CodeConflict, "来源订单条目不存在")
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定来源订单条目失败", err)
		}
		if expected := itemOrders[itemID]; expected == uuid.Nil || expected != orderID {
			return apierror.New(apierror.CodeConflict, "来源订单条目已变化")
		}
		delta := grouped[itemID].Mul(direction)
		next := projected.Add(delta)
		if next.IsNegative() {
			return apierror.New(apierror.CodeConflict, "订单履约投影不能为负")
		}
		if verify && next.GreaterThan(baseQty.Mul(decimal.NewFromInt(1).Add(ratio))) {
			return apierror.New(apierror.CodeConflict, "超出订单条目可履约数量")
		}
		if _, err := tx.Exec(ctx, `UPDATE `+spec.itemTable+` SET `+projectionColumn+
			`=$2,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, itemID, next); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "更新订单履约投影失败", err)
		}
		if demandLine != nil {
			demandDeltas[*demandLine] = demandDeltas[*demandLine].Add(delta)
		}
	}
	if side == SidePurchase {
		if err := adjustDemandReceived(ctx, tx, demandDeltas); err != nil {
			return err
		}
	}
	return nil
}

// PostOutsourcedIssue increments issued_qty for the referenced outsourced
// material-list rows. Deliberate legacy behavior: there is no over-issue gate.
func (s *Service) PostOutsourcedIssue(
	ctx context.Context,
	tx pgx.Tx,
	input OutsourcedIssueInput,
) error {
	return s.adjustOutsourcedIssue(ctx, tx, input, decimal.NewFromInt(1), true)
}

func (s *Service) ReverseOutsourcedIssue(
	ctx context.Context,
	tx pgx.Tx,
	input OutsourcedIssueInput,
) error {
	return s.adjustOutsourcedIssue(ctx, tx, input, decimal.NewFromInt(-1), false)
}

func (s *Service) adjustOutsourcedIssue(
	ctx context.Context,
	tx pgx.Tx,
	input OutsourcedIssueInput,
	direction decimal.Decimal,
	verify bool,
) error {
	grouped, err := groupOutsourcedIssueLines(input.Lines)
	if err != nil {
		return err
	}
	materialIDs := make([]uuid.UUID, 0, len(grouped))
	for id := range grouped {
		materialIDs = append(materialIDs, id)
	}
	sort.Slice(materialIDs, func(i, j int) bool {
		return materialIDs[i].String() < materialIDs[j].String()
	})

	itemOrders := make(map[uuid.UUID]uuid.UUID, len(materialIDs))
	orderSet := make(map[uuid.UUID]struct{})
	rows, err := tx.Query(ctx, `SELECT m.id,i.order_id
		FROM pur_order_item_material m
		JOIN pur_order_item i ON i.id=m.order_item_id
		WHERE m.id=ANY($1::uuid[])`, materialIDs)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取委外发料来源失败", err)
	}
	for rows.Next() {
		var materialID, orderID uuid.UUID
		if err := rows.Scan(&materialID, &orderID); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取委外发料来源失败", err)
		}
		itemOrders[materialID] = orderID
		orderSet[orderID] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "遍历委外发料来源失败", err)
	}
	if len(itemOrders) != len(grouped) {
		return apierror.New(apierror.CodeConflict, "来源发料清单行不存在")
	}

	orderIDs := make([]uuid.UUID, 0, len(orderSet))
	for id := range orderSet {
		orderIDs = append(orderIDs, id)
	}
	sort.Slice(orderIDs, func(i, j int) bool {
		return orderIDs[i].String() < orderIDs[j].String()
	})
	for _, orderID := range orderIDs {
		var item lockedProjectionOrder
		if err := tx.QueryRow(ctx, `SELECT status,is_outsourced,company_id,party_type,party_id
			FROM pur_order WHERE id=$1 FOR UPDATE`, orderID).Scan(
			&item.status, &item.isOutsourced, &item.companyID, &item.partyType, &item.partyID,
		); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定委外采购订单失败", err)
		}
		if verify && item.status != "audited" {
			return apierror.New(apierror.CodeConflict, "来源委外采购订单须为已审核")
		}
		if !item.isOutsourced || item.companyID != input.CompanyID ||
			!strings.EqualFold(item.partyType, input.PartyType) || item.partyID != input.PartyID {
			return apierror.New(apierror.CodeConflict, "来源委外采购订单与发料单不匹配")
		}
	}

	for _, materialID := range materialIDs {
		var (
			orderID   uuid.UUID
			issuedQty decimal.Decimal
		)
		err := tx.QueryRow(ctx, `SELECT i.order_id,m.issued_qty
			FROM pur_order_item_material m
			JOIN pur_order_item i ON i.id=m.order_item_id
			WHERE m.id=$1 FOR UPDATE OF m`, materialID).Scan(&orderID, &issuedQty)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.New(apierror.CodeConflict, "来源发料清单行不存在")
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定来源发料清单行失败", err)
		}
		if itemOrders[materialID] != orderID {
			return apierror.New(apierror.CodeConflict, "来源发料清单行已变化")
		}
		next := issuedQty.Add(grouped[materialID].Mul(direction))
		if next.IsNegative() {
			return apierror.New(apierror.CodeConflict, "订单发料投影不能为负")
		}
		if _, err := tx.Exec(ctx, `UPDATE pur_order_item_material
			SET issued_qty=$2,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			materialID, next,
		); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "更新订单发料投影失败", err)
		}
	}
	return nil
}

func groupFulfillmentLines(lines []FulfillmentLine) (map[uuid.UUID]decimal.Decimal, error) {
	grouped := make(map[uuid.UUID]decimal.Decimal)
	for i, line := range lines {
		if line.OrderItemID == uuid.Nil || !line.BaseQty.GreaterThan(decimal.Zero) {
			return nil, apierror.Validation("履约投影参数不合法", map[string][]string{
				fmt.Sprintf("lines.%d", i): {"订单条目和正数数量必填"},
			})
		}
		grouped[line.OrderItemID] = grouped[line.OrderItemID].Add(line.BaseQty)
	}
	if len(grouped) == 0 {
		return nil, apierror.Validation("履约投影参数不合法",
			map[string][]string{"lines": {"至少一行"}})
	}
	return grouped, nil
}

func groupOutsourcedIssueLines(lines []OutsourcedIssueLine) (map[uuid.UUID]decimal.Decimal, error) {
	grouped := make(map[uuid.UUID]decimal.Decimal)
	for i, line := range lines {
		if line.OrderItemMaterialID == uuid.Nil || !line.BaseQty.GreaterThan(decimal.Zero) {
			return nil, apierror.Validation("委外发料投影参数不合法", map[string][]string{
				fmt.Sprintf("lines.%d", i): {"发料清单行和正数数量必填"},
			})
		}
		grouped[line.OrderItemMaterialID] = grouped[line.OrderItemMaterialID].Add(line.BaseQty)
	}
	if len(grouped) == 0 {
		return nil, apierror.Validation("委外发料投影参数不合法",
			map[string][]string{"lines": {"至少一行"}})
	}
	return grouped, nil
}

func fulfillmentItemIDs(grouped map[uuid.UUID]decimal.Decimal) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(grouped))
	for id := range grouped {
		ids = append(ids, id)
	}
	return ids
}

func lockProjectionOrders(
	ctx context.Context,
	tx pgx.Tx,
	spec sideSpec,
	itemIDs []uuid.UUID,
) (map[uuid.UUID]lockedProjectionOrder, map[uuid.UUID]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT id,order_id FROM `+spec.itemTable+
		` WHERE id=ANY($1::uuid[])`, itemIDs)
	if err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取履约来源订单失败", err)
	}
	itemOrders := make(map[uuid.UUID]uuid.UUID, len(itemIDs))
	orderIDs := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var itemID, orderID uuid.UUID
		if err := rows.Scan(&itemID, &orderID); err != nil {
			rows.Close()
			return nil, nil, apierror.Wrap(apierror.CodeInternal, "读取履约来源订单失败", err)
		}
		itemOrders[itemID] = orderID
		orderIDs[orderID] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, apierror.Wrap(apierror.CodeInternal, "遍历履约来源订单失败", err)
	}
	if len(itemOrders) != len(itemIDs) {
		return nil, nil, apierror.New(apierror.CodeConflict, "来源订单条目不存在")
	}

	locked := make(map[uuid.UUID]lockedProjectionOrder, len(orderIDs))
	for _, orderID := range sortedUUIDs(orderIDs) {
		var item lockedProjectionOrder
		isOutsourced := "false"
		if spec.side == SidePurchase {
			isOutsourced = "is_outsourced"
		}
		err := tx.QueryRow(ctx, `SELECT status,`+isOutsourced+
			`,company_id,party_type,party_id FROM `+spec.headTable+
			` WHERE id=$1 FOR UPDATE`, orderID).Scan(
			&item.status, &item.isOutsourced, &item.companyID, &item.partyType, &item.partyID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, apierror.New(apierror.CodeConflict, "来源订单不存在")
		}
		if err != nil {
			return nil, nil, apierror.Wrap(apierror.CodeInternal, "锁定履约来源订单失败", err)
		}
		locked[orderID] = item
	}
	return locked, itemOrders, nil
}

func validateProjectionOrders(
	orders map[uuid.UUID]lockedProjectionOrder,
	input FulfillmentInput,
	verify bool,
) error {
	for _, item := range orders {
		if verify && item.status != "audited" {
			return apierror.New(apierror.CodeConflict, "来源订单须为已审核")
		}
		if item.companyID != input.CompanyID ||
			!strings.EqualFold(item.partyType, input.PartyType) || item.partyID != input.PartyID {
			return apierror.New(apierror.CodeConflict, "来源订单与履约单公司或对手不一致")
		}
		if input.RequireOutsourced != nil && item.isOutsourced != *input.RequireOutsourced {
			return apierror.New(apierror.CodeConflict, "来源订单委外类型与履约单不匹配")
		}
	}
	return nil
}

func adjustDemandReceived(
	ctx context.Context,
	tx pgx.Tx,
	deltas map[uuid.UUID]decimal.Decimal,
) error {
	for _, lineID := range sortedUUIDs(deltas) {
		var baseQty, receivedQty decimal.Decimal
		if err := tx.QueryRow(ctx, `SELECT base_qty,received_qty
			FROM mfg_demand_item WHERE id=$1 FOR UPDATE`, lineID).Scan(
			&baseQty, &receivedQty,
		); errors.Is(err, pgx.ErrNoRows) {
			return apierror.New(apierror.CodeConflict, "来源履约需求行不存在")
		} else if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定来源履约需求行失败", err)
		}
		next := receivedQty.Add(deltas[lineID])
		if next.IsNegative() {
			return apierror.New(apierror.CodeConflict, "需求已收投影不能为负")
		}
		status := "pending"
		if !next.LessThan(baseQty) {
			status = "completed"
		}
		if _, err := tx.Exec(ctx, `UPDATE mfg_demand_item
			SET received_qty=$2,status=$3,updated_at=(now() AT TIME ZONE 'utc')
			WHERE id=$1`, lineID, next, status); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "更新需求已收投影失败", err)
		}
	}
	return nil
}
