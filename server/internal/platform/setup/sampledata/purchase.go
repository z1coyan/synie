package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedPurchase(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
) (purchaseResult, error) {
	result := purchaseResult{
		QuotationItems: map[string]map[string]uuid.UUID{},
		OrderItems:     map[string]map[int]uuid.UUID{},
		ReceiptItems:   map[string]map[int]uuid.UUID{},
	}

	// pq1
	items, id, err := createSideQuotation(ctx, deps, actor, sc, md, quotation.SidePurchase,
		md.Suppliers["S01"].ID, 88, 90, ptr("到厂价含税,运费另计"), true,
		[]pricedLine{{"copper_rod", "52.00"}, {"copper_bar", "36.80"}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["pq1"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SidePurchase,
		md.Suppliers["S04"].ID, 72, 90, ptr("含运费到厂"), true,
		[]pricedLine{{"steel_sheet", "85.00"}, {"stamped_part", "6.50"}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["pq2"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SidePurchase,
		md.Suppliers["S05"].ID, 50, 60, ptr("含税,款到发货"), true,
		[]pricedLine{{"abs_pellet", "14.20"}, {"stretch_film", "28.00"}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["pq3"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SidePurchase,
		md.Suppliers["S02"].ID, 30, 45, ptr("含税,月结 30 天"), true,
		[]pricedLine{{"screw", "0.045"}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["pq4"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SidePurchase,
		md.Suppliers["S06"].ID, 6, 30, nil, false,
		[]pricedLine{{"carton", "3.80"}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["pq5"] = items

	oItems, oID, err := createSideOrder(ctx, deps, actor, sc, order.SidePurchase,
		md.Suppliers["S01"].ID, 75, "初始化示例采购订单(已审核)", true,
		[]orderLine{
			{result.QuotationItems["pq1"]["copper_rod"], 500},
			{result.QuotationItems["pq1"]["copper_bar"], 200},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["po1"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SidePurchase,
		md.Suppliers["S04"].ID, 60, "初始化示例采购订单(已审核)", true,
		[]orderLine{
			{result.QuotationItems["pq2"]["steel_sheet"], 400},
			{result.QuotationItems["pq2"]["stamped_part"], 600},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["po2"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SidePurchase,
		md.Suppliers["S05"].ID, 35, "初始化示例采购订单(已审核)", true,
		[]orderLine{
			{result.QuotationItems["pq3"]["abs_pellet"], 800},
			{result.QuotationItems["pq3"]["stretch_film"], 200},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["po3"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SidePurchase,
		md.Suppliers["S02"].ID, 8, "初始化示例采购订单(草稿,可改后审核)", false,
		[]orderLine{{result.QuotationItems["pq4"]["screw"], 5000}})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["po4"] = oItems

	rItems, rID, err := createSideFulfillment(ctx, deps, actor, sc, standard.SidePurchase,
		md.Suppliers["S01"].ID, 70, sc.Accounts.Inventory, sc.Accounts.UnbilledAP,
		[]fulfillLine{
			{result.OrderItems["po1"][0], 500},
			{result.OrderItems["po1"][1], 200},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Receipts = append(result.Receipts, rID)
	result.ReceiptItems["pr1"] = rItems

	rItems, rID, err = createSideFulfillment(ctx, deps, actor, sc, standard.SidePurchase,
		md.Suppliers["S04"].ID, 45, sc.Accounts.Inventory, sc.Accounts.UnbilledAP,
		[]fulfillLine{
			{result.OrderItems["po2"][0], 400},
			{result.OrderItems["po2"][1], 600},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Receipts = append(result.Receipts, rID)
	result.ReceiptItems["pr2"] = rItems

	rItems, rID, err = createSideFulfillment(ctx, deps, actor, sc, standard.SidePurchase,
		md.Suppliers["S05"].ID, 25, sc.Accounts.Inventory, sc.Accounts.UnbilledAP,
		[]fulfillLine{
			{result.OrderItems["po3"][0], 800},
			{result.OrderItems["po3"][1], 150},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Receipts = append(result.Receipts, rID)
	result.ReceiptItems["pr3"] = rItems

	pcr1, total, err := createSideReconciliation(ctx, deps, actor, sc, reconciliation.SidePurchase,
		md.Suppliers["S01"].ID, "初始化示例采购对账(已确认)", true,
		[]reconLine{
			{result.ReceiptItems["pr1"][0], 500, "receipt"},
			{result.ReceiptItems["pr1"][1], 200, "receipt"},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Reconciliations = append(result.Reconciliations, pcr1)
	result.ConfirmedReconciliation = pcr1
	result.ConfirmedBaseGrossTotal = total

	pcr2, _, err := createSideReconciliation(ctx, deps, actor, sc, reconciliation.SidePurchase,
		md.Suppliers["S04"].ID, "初始化示例采购对账(草稿)", false,
		[]reconLine{
			{result.ReceiptItems["pr2"][0], 400, "receipt"},
			{result.ReceiptItems["pr2"][1], 300, "receipt"},
		})
	if err != nil {
		return purchaseResult{}, err
	}
	result.Reconciliations = append(result.Reconciliations, pcr2)
	return result, nil
}

type pricedLine struct {
	key   string
	price string
}

type orderLine struct {
	quotationItemID uuid.UUID
	qty             int64
}

type fulfillLine struct {
	orderItemID uuid.UUID
	qty         int64
}

type reconLine struct {
	sourceItemID uuid.UUID
	qty          int64
	kind         string // delivery | receipt | outsourced
}

func createSideQuotation(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
	side quotation.Side, partyID uuid.UUID, dateAgo, validDays int, terms *string, audit bool,
	items []pricedLine,
) (map[string]uuid.UUID, uuid.UUID, error) {
	date := daysAgo(dateAgo)
	validUntil := date.AddDate(0, 0, validDays)
	partyType := "customer"
	label := "销售"
	if side == quotation.SidePurchase {
		partyType = "supplier"
		label = "采购"
	}
	statusLabel := "草稿"
	if audit {
		statusLabel = "已审核"
	}
	head, err := deps.Quotations.CreateQuotation(ctx, actor, side, quotation.CreateQuotationInput{
		CompanyID: sc.Company.ID, QuotationDate: &date, ValidUntil: validUntil,
		PartyType: partyType, PartyID: partyID, Terms: terms,
		Remarks: ptr("初始化示例" + label + "报价(" + statusLabel + ")"),
	})
	if err != nil {
		return nil, uuid.Nil, err
	}
	byKey := map[string]uuid.UUID{}
	for i, line := range items {
		mat := md.Materials[line.key]
		price := dec(line.price)
		tax := dec("0.13")
		item, err := deps.Quotations.CreateItem(ctx, actor, side, quotation.CreateItemInput{
			QuotationID: head.ID, Idx: int64(i + 1), MaterialID: mat.ID, UnitID: mat.DefaultUnitID,
			PricingMode: quotation.PricingFixed, Price: &price, TaxRate: &tax,
		})
		if err != nil {
			return nil, uuid.Nil, err
		}
		byKey[line.key] = item.ID
	}
	if audit {
		if _, err := deps.Quotations.AuditQuotation(ctx, actor, side, head.ID); err != nil {
			return nil, uuid.Nil, err
		}
	}
	return byKey, head.ID, nil
}

func createSideOrder(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	side order.Side, partyID uuid.UUID, dateAgo int, remarks string, audit bool,
	items []orderLine,
) (map[int]uuid.UUID, uuid.UUID, error) {
	date := daysAgo(dateAgo)
	partyType := "customer"
	if side == order.SidePurchase {
		partyType = "supplier"
	}
	head, err := deps.Orders.CreateOrder(ctx, actor, side, order.CreateOrderInput{
		CompanyID: sc.Company.ID, OrderDate: &date, OrderType: order.OrderTypeRegular,
		PartyType: partyType, PartyID: partyID, Remarks: ptr(remarks),
	})
	if err != nil {
		return nil, uuid.Nil, err
	}
	byIdx := map[int]uuid.UUID{}
	for i, line := range items {
		qi := line.quotationItemID
		item, err := deps.Orders.CreateItem(ctx, actor, side, order.CreateItemInput{
			OrderID: head.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(line.qty),
			QuotationItemID: &qi,
		})
		if err != nil {
			return nil, uuid.Nil, err
		}
		byIdx[i] = item.ID
	}
	if audit {
		if _, err := deps.Orders.AuditOrder(ctx, actor, side, head.ID); err != nil {
			return nil, uuid.Nil, err
		}
	}
	return byIdx, head.ID, nil
}

func createSideFulfillment(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	side standard.Side, partyID uuid.UUID, dateAgo int, debit, credit uuid.UUID,
	items []fulfillLine,
) (map[int]uuid.UUID, uuid.UUID, error) {
	date := daysAgo(dateAgo)
	wh := sc.Warehouses.Default
	partyType := "customer"
	remarks := "初始化示例销售发货"
	if side == standard.SidePurchase {
		partyType = "supplier"
		remarks = "初始化示例采购入库"
	}
	head, err := deps.StandardFulfillment.CreateHead(ctx, actor, side, standard.CreateHeadInput{
		CompanyID: sc.Company.ID, DocumentDate: &date, PostingDate: &date,
		PartyType: partyType, PartyID: partyID, WarehouseID: &wh,
		DebitAccountID: debit, CreditAccountID: credit, Remarks: ptr(remarks),
	})
	if err != nil {
		return nil, uuid.Nil, err
	}
	byIdx := map[int]uuid.UUID{}
	for i, line := range items {
		item, err := deps.StandardFulfillment.CreateItem(ctx, actor, side, standard.CreateItemInput{
			HeadID: head.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(line.qty),
			OrderItemID: line.orderItemID, WarehouseID: wh,
		})
		if err != nil {
			return nil, uuid.Nil, err
		}
		byIdx[i] = item.ID
	}
	if _, err := deps.StandardFulfillment.Audit(ctx, actor, side, head.ID, nil); err != nil {
		return nil, uuid.Nil, err
	}
	return byIdx, head.ID, nil
}

func createSideReconciliation(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	side reconciliation.Side, partyID uuid.UUID, remarks string, confirm bool,
	items []reconLine,
) (uuid.UUID, string, error) {
	partyType := "customer"
	if side == reconciliation.SidePurchase {
		partyType = "supplier"
	}
	head, err := deps.Reconciliations.CreateHead(ctx, actor, side, reconciliation.CreateHeadInput{
		CompanyID: sc.Company.ID, Kind: reconciliation.KindRegular,
		PartyType: partyType, PartyID: partyID, Remarks: ptr(remarks),
	})
	if err != nil {
		return uuid.Nil, "", err
	}
	for i, line := range items {
		input := reconciliation.CreateItemInput{
			ReconciliationID: head.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(line.qty),
		}
		id := line.sourceItemID
		switch line.kind {
		case "delivery":
			input.DeliveryItemID = &id
		case "receipt":
			input.ReceiptItemID = &id
		case "outsourced":
			input.OutsourcedReceiptItemID = &id
		}
		if _, err := deps.Reconciliations.CreateItem(ctx, actor, side, input); err != nil {
			return uuid.Nil, "", err
		}
	}
	if confirm {
		confirmed, err := deps.Reconciliations.Confirm(ctx, actor, side, head.ID)
		if err != nil {
			return uuid.Nil, "", err
		}
		return confirmed.ID, confirmed.BaseGrossTotal.StringFixed(2), nil
	}
	got, err := deps.Reconciliations.GetHead(ctx, actor, side, head.ID)
	if err != nil {
		return head.ID, "0.00", nil
	}
	return got.ID, got.BaseGrossTotal.StringFixed(2), nil
}
