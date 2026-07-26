package standard

import "github.com/z1coyan/synie/server/internal/platform/apierror"

type sideSpec struct {
	side             Side
	label            string
	itemLabel        string
	prefix           string
	headTable        string
	itemTable        string
	orderTable       string
	orderItemTable   string
	orderProjection  string
	headOwnerType    string
	itemOwnerType    string
	voucherType      string
	numberResource   string
	allowedPartyType map[string]struct{}
	requiredRoleSide string
	requiredRole     string
	stockDirection   int64
}

var specs = map[Side]sideSpec{
	SideSales: {
		side: SideSales, label: "销售发货单", itemLabel: "销售发货条目",
		prefix: "sales.delivery", headTable: "sal_delivery", itemTable: "sal_delivery_item",
		orderTable: "sal_order", orderItemTable: "sal_order_item", orderProjection: "shipped_qty",
		headOwnerType: "sal_delivery", itemOwnerType: "sal_delivery_item",
		voucherType: "sales.delivery", numberResource: "sales.delivery",
		allowedPartyType: map[string]struct{}{"customer": {}, "company": {}},
		requiredRoleSide: "debit", requiredRole: "unbilled_receivable", stockDirection: -1,
	},
	SidePurchase: {
		side: SidePurchase, label: "采购入库单", itemLabel: "采购入库条目",
		prefix: "purchase.receipt", headTable: "pur_receipt", itemTable: "pur_receipt_item",
		orderTable: "pur_order", orderItemTable: "pur_order_item", orderProjection: "received_qty",
		headOwnerType: "pur_receipt", itemOwnerType: "pur_receipt_item",
		voucherType: "purchase.receipt", numberResource: "purchase.receipt",
		allowedPartyType: map[string]struct{}{"supplier": {}, "company": {}},
		requiredRoleSide: "credit", requiredRole: "unbilled_payable", stockDirection: 1,
	},
}

func specFor(side Side) (sideSpec, error) {
	spec, ok := specs[side]
	if !ok {
		return sideSpec{}, apierror.New(apierror.CodeValidation, "标准履约方向不合法")
	}
	return spec, nil
}

func mustSpec(side Side) sideSpec {
	spec, ok := specs[side]
	if !ok {
		panic("unknown standard fulfillment side: " + string(side))
	}
	return spec
}
