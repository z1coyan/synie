package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedOutsourced(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
) (outsourcedResult, error) {
	s04 := md.Suppliers["S04"]

	// 委外方案 BOM
	bom, err := deps.ManufacturingMaster.CreateBOM(ctx, actor, master.BOMCreateInput{
		MaterialID: md.Materials["busbar"].ID, PlanName: ptr("委外方案"), Note: ptr("委外加工配方(示例)"),
	})
	if err != nil {
		return outsourcedResult{}, err
	}
	for _, row := range []struct {
		key  string
		qty  string
		loss *string
	}{
		{"copper_bar", "1.2", ptr("0.05")},
		{"terminal_block", "8", nil},
		{"insul_sleeve", "0.3", nil},
	} {
		if err := createBOMComponent(ctx, deps, actor, bom.ID, md, row.key, row.qty, row.loss, nil); err != nil {
			return outsourcedResult{}, err
		}
	}
	scrap := md.Materials["scrap_copper"]
	if _, err := deps.ManufacturingMaster.CreateBOMByproduct(ctx, actor, master.ByproductInput{
		Quantity: dec("0.06"), Note: ptr("委外下料边角料"), BOMID: bom.ID,
		MaterialID: scrap.ID, UnitID: scrap.DefaultUnitID,
	}); err != nil {
		return outsourcedResult{}, err
	}

	// 外协仓
	partyType := "supplier"
	wh, err := deps.Warehouses.Create(ctx, actor, warehouse.CreateInput{
		Name:   sc.Company.Code + " - 外协仓-" + deref(s04.ShortName, s04.Name),
		IsLeaf: ptr(true), IsOutsourced: ptr(true), PartyType: &partyType, PartyID: &s04.ID,
		CompanyID: sc.Company.ID, ParentID: &sc.Warehouses.Root,
	})
	if err != nil {
		return outsourcedResult{}, err
	}

	order1, matLines, err := createOutsourcedOrder(ctx, deps, actor, sc, md, s04.ID, 15,
		"初始化示例委外订单(已审核)", true, bom.ID, 80,
		[]struct {
			key string
			qty string
		}{{"copper_bar", "100.8"}, {"terminal_block", "640"}, {"insul_sleeve", "24"}},
		[]struct {
			key string
			qty string
		}{{"scrap_copper", "4.8"}},
	)
	if err != nil {
		return outsourcedResult{}, err
	}
	order2, _, err := createOutsourcedOrder(ctx, deps, actor, sc, md, s04.ID, 2,
		"初始化示例委外订单(草稿,可改后审核)", false, bom.ID, 20,
		[]struct {
			key string
			qty string
		}{{"copper_bar", "25.2"}, {"terminal_block", "160"}},
		[]struct {
			key string
			qty string
		}{{"scrap_copper", "1.2"}},
	)
	if err != nil {
		return outsourcedResult{}, err
	}

	issueID, err := createOutsourcedIssue(ctx, deps, actor, sc, s04.ID, wh.ID, matLines)
	if err != nil {
		return outsourcedResult{}, err
	}
	receiptItemID, receiptID, err := createOutsourcedReceipt(ctx, deps, actor, sc, s04.ID, wh.ID, order1.itemID)
	if err != nil {
		return outsourcedResult{}, err
	}

	reconID, _, err := createSideReconciliation(ctx, deps, actor, sc, reconciliation.SidePurchase,
		s04.ID, "初始化示例委外加工费对账(草稿)", false,
		[]reconLine{{receiptItemID, 30, "outsourced"}})
	if err != nil {
		return outsourcedResult{}, err
	}

	return outsourcedResult{
		BOMs:            []uuid.UUID{bom.ID},
		Orders:          []uuid.UUID{order1.orderID, order2.orderID},
		Issues:          []uuid.UUID{issueID},
		Receipts:        []uuid.UUID{receiptID},
		Reconciliations: []uuid.UUID{reconID},
	}, nil
}

type outsourcedOrderResult struct {
	orderID uuid.UUID
	itemID  uuid.UUID
}

func createOutsourcedOrder(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
	supplierID uuid.UUID, dateAgo int, remarks string, audit bool, bomID uuid.UUID, qty int64,
	materials []struct {
		key string
		qty string
	},
	byproducts []struct {
		key string
		qty string
	},
) (outsourcedOrderResult, []uuid.UUID, error) {
	date := daysAgo(dateAgo)
	head, err := deps.Orders.CreateOrder(ctx, actor, order.SidePurchase, order.CreateOrderInput{
		CompanyID: sc.Company.ID, OrderDate: &date, OrderType: order.OrderTypeSpot,
		IsOutsourced: true, PartyType: "supplier", PartyID: supplierID, Remarks: ptr(remarks),
	})
	if err != nil {
		return outsourcedOrderResult{}, nil, err
	}
	mat := md.Materials["busbar"]
	price := dec("12.50")
	tax := dec("0.13")
	item, err := deps.Orders.CreateItem(ctx, actor, order.SidePurchase, order.CreateItemInput{
		OrderID: head.ID, Idx: 1, Qty: decimal.NewFromInt(qty),
		MaterialID: mat.ID, UnitID: mat.DefaultUnitID, Price: &price, TaxRate: &tax, BOMID: &bomID,
	})
	if err != nil {
		return outsourcedOrderResult{}, nil, err
	}
	var matLineIDs []uuid.UUID
	for _, line := range materials {
		m := md.Materials[line.key]
		created, err := deps.Orders.CreateMaterial(ctx, actor, order.CreateMaterialInput{
			OrderItemID: item.ID, MaterialID: m.ID, UnitID: m.DefaultUnitID, Quantity: dec(line.qty),
		})
		if err != nil {
			return outsourcedOrderResult{}, nil, err
		}
		matLineIDs = append(matLineIDs, created.ID)
	}
	for _, line := range byproducts {
		m := md.Materials[line.key]
		if _, err := deps.Orders.CreateByproduct(ctx, actor, order.CreateByproductInput{
			OrderItemID: item.ID, MaterialID: m.ID, UnitID: m.DefaultUnitID, Quantity: dec(line.qty),
		}); err != nil {
			return outsourcedOrderResult{}, nil, err
		}
	}
	if audit {
		if _, err := deps.Orders.AuditOrder(ctx, actor, order.SidePurchase, head.ID); err != nil {
			return outsourcedOrderResult{}, nil, err
		}
	}
	return outsourcedOrderResult{orderID: head.ID, itemID: item.ID}, matLineIDs, nil
}

func createOutsourcedIssue(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	supplierID, outsourcedWH uuid.UUID, matLines []uuid.UUID,
) (uuid.UUID, error) {
	date := daysAgo(9)
	from := sc.Warehouses.Default
	issue, err := deps.OutsourcedFulfillment.CreateIssue(ctx, actor, outsourced.CreateIssueInput{
		CompanyID: sc.Company.ID, IssueDate: &date, PartyType: "supplier", PartyID: supplierID,
		FromWarehouseID: &from, OutsourcedWarehouseID: &outsourcedWH,
		Remarks: ptr("初始化示例委外发料"),
	})
	if err != nil {
		return uuid.Nil, err
	}
	qtys := []int64{60, 400, 15}
	for i, lineID := range matLines {
		if _, err := deps.OutsourcedFulfillment.CreateIssueItem(ctx, actor, outsourced.CreateIssueItemInput{
			IssueID: issue.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(qtys[i]),
			OrderItemMaterialID: lineID, FromWarehouseID: &from, OutsourcedWarehouseID: &outsourcedWH,
		}); err != nil {
			return uuid.Nil, err
		}
	}
	if _, err := deps.OutsourcedFulfillment.AuditIssue(ctx, actor, issue.ID); err != nil {
		return uuid.Nil, err
	}
	return issue.ID, nil
}

func createOutsourcedReceipt(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	supplierID, outsourcedWH, orderItemID uuid.UUID,
) (uuid.UUID, uuid.UUID, error) {
	date := daysAgo(4)
	finished := sc.Warehouses.Finished
	debit := sc.Accounts.Inventory
	credit := sc.Accounts.UnbilledAP
	receipt, err := deps.OutsourcedFulfillment.CreateReceipt(ctx, actor, outsourced.CreateReceiptInput{
		CompanyID: sc.Company.ID, ReceiptDate: &date, PostingDate: &date,
		PartyType: "supplier", PartyID: supplierID,
		WarehouseID: &finished, OutsourcedWarehouseID: &outsourcedWH,
		DebitAccountID: &debit, CreditAccountID: &credit,
		Remarks: ptr("初始化示例委外入库"),
	})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	item, err := deps.OutsourcedFulfillment.CreateReceiptItem(ctx, actor, outsourced.CreateReceiptItemInput{
		ReceiptID: receipt.ID, Idx: 1, Qty: decimal.NewFromInt(30),
		OrderItemID: orderItemID, WarehouseID: &finished,
	})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if _, err := deps.OutsourcedFulfillment.AuditReceipt(ctx, actor, receipt.ID, outsourced.AuditReceiptInput{}); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return item.ID, receipt.ID, nil
}

func deref(p *string, fallback string) string {
	if p != nil && *p != "" {
		return *p
	}
	return fallback
}
