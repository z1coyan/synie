package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedSales(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
) (salesResult, error) {
	result := salesResult{
		QuotationItems: map[string]map[string]uuid.UUID{},
		OrderItems:     map[string]map[int]uuid.UUID{},
		DeliveryItems:  map[string]map[int]uuid.UUID{},
	}

	items, id, err := createSideQuotation(ctx, deps, actor, sc, md, quotation.SideSales,
		md.Customers["C01"].ID, 88, 90, ptr("示例:含税交货,账期月结 30 天"), true,
		[]pricedLine{{"box_shell", "128.00"}, {"busbar", "86.50"}, {"terminal_block", "2.35"}})
	if err != nil {
		return salesResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["sq1"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SideSales,
		md.Customers["C02"].ID, 75, 90, ptr("含税交货,款到发货"), true,
		[]pricedLine{{"mount_plate", "45.00"}, {"terminal_block", "2.40"}, {"copper_terminal", "1.20"}})
	if err != nil {
		return salesResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["sq2"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SideSales,
		md.Customers["C03"].ID, 40, 60, ptr("含税交货"), true,
		[]pricedLine{{"terminal_assy", "32.00"}, {"insul_sleeve", "18.50"}})
	if err != nil {
		return salesResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["sq3"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SideSales,
		md.Customers["C05"].ID, 15, 45, ptr("含税交货"), true,
		[]pricedLine{{"terminal_block", "2.50"}, {"copper_terminal", "1.30"}})
	if err != nil {
		return salesResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["sq4"] = items

	items, id, err = createSideQuotation(ctx, deps, actor, sc, md, quotation.SideSales,
		md.Customers["C04"].ID, 5, 25, nil, false,
		[]pricedLine{{"rail", "22.00"}, {"copper_terminal", "1.25"}})
	if err != nil {
		return salesResult{}, err
	}
	result.Quotations = append(result.Quotations, id)
	result.QuotationItems["sq5"] = items

	oItems, oID, err := createSideOrder(ctx, deps, actor, sc, order.SideSales,
		md.Customers["C01"].ID, 70, "初始化示例销售订单(已审核,两单发完)", true,
		[]orderLine{
			{result.QuotationItems["sq1"]["box_shell"], 50},
			{result.QuotationItems["sq1"]["busbar"], 20},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["so1"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SideSales,
		md.Customers["C02"].ID, 55, "初始化示例销售订单(已审核)", true,
		[]orderLine{
			{result.QuotationItems["sq2"]["mount_plate"], 25},
			{result.QuotationItems["sq2"]["terminal_block"], 500},
			{result.QuotationItems["sq2"]["copper_terminal"], 800},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["so2"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SideSales,
		md.Customers["C03"].ID, 20, "初始化示例销售订单(已审核,待发货)", true,
		[]orderLine{{result.QuotationItems["sq3"]["terminal_assy"], 40}})
	if err != nil {
		return salesResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["so3"] = oItems

	oItems, oID, err = createSideOrder(ctx, deps, actor, sc, order.SideSales,
		md.Customers["C01"].ID, 3, "初始化示例销售订单(草稿,可改后审核)", false,
		[]orderLine{{result.QuotationItems["sq1"]["busbar"], 10}})
	if err != nil {
		return salesResult{}, err
	}
	result.Orders = append(result.Orders, oID)
	result.OrderItems["so4"] = oItems

	dItems, dID, err := createSideFulfillment(ctx, deps, actor, sc, standard.SideSales,
		md.Customers["C01"].ID, 60, sc.Accounts.UnbilledAR, sc.Accounts.Revenue,
		[]fulfillLine{
			{result.OrderItems["so1"][0], 30},
			{result.OrderItems["so1"][1], 20},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Deliveries = append(result.Deliveries, dID)
	result.DeliveryItems["sd1"] = dItems

	dItems, dID, err = createSideFulfillment(ctx, deps, actor, sc, standard.SideSales,
		md.Customers["C01"].ID, 30, sc.Accounts.UnbilledAR, sc.Accounts.Revenue,
		[]fulfillLine{{result.OrderItems["so1"][0], 20}})
	if err != nil {
		return salesResult{}, err
	}
	result.Deliveries = append(result.Deliveries, dID)
	result.DeliveryItems["sd2"] = dItems

	dItems, dID, err = createSideFulfillment(ctx, deps, actor, sc, standard.SideSales,
		md.Customers["C02"].ID, 12, sc.Accounts.UnbilledAR, sc.Accounts.Revenue,
		[]fulfillLine{
			{result.OrderItems["so2"][0], 25},
			{result.OrderItems["so2"][1], 500},
			{result.OrderItems["so2"][2], 800},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Deliveries = append(result.Deliveries, dID)
	result.DeliveryItems["sd3"] = dItems

	sr1, total, err := createSideReconciliation(ctx, deps, actor, sc, reconciliation.SideSales,
		md.Customers["C01"].ID, "初始化示例销售对账(已确认)", true,
		[]reconLine{
			{result.DeliveryItems["sd1"][0], 30, "delivery"},
			{result.DeliveryItems["sd1"][1], 20, "delivery"},
			{result.DeliveryItems["sd2"][0], 20, "delivery"},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Reconciliations = append(result.Reconciliations, sr1)
	result.ConfirmedReconciliation = sr1
	result.ConfirmedBaseGrossTotal = total

	sr2, _, err := createSideReconciliation(ctx, deps, actor, sc, reconciliation.SideSales,
		md.Customers["C02"].ID, "初始化示例销售对账(草稿)", false,
		[]reconLine{
			{result.DeliveryItems["sd3"][0], 25, "delivery"},
			{result.DeliveryItems["sd3"][1], 300, "delivery"},
			{result.DeliveryItems["sd3"][2], 800, "delivery"},
		})
	if err != nil {
		return salesResult{}, err
	}
	result.Reconciliations = append(result.Reconciliations, sr2)
	return result, nil
}
