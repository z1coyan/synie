package order

import "github.com/z1coyan/synie/server/internal/platform/apierror"

type sideSpec struct {
	side              Side
	prefix            string
	label             string
	headTable         string
	itemTable         string
	headResource      string
	itemResource      string
	itemOwnerType     string
	numberResource    string
	headDestroy       string
	itemDestroy       string
	auditMutation     string
	closeMutation     string
	voidMutation      string
	nonRegularType    OrderType
	nonRegularSetting string
	allowedParty      map[string]struct{}
}

var specs = map[Side]sideSpec{
	SideSales: {
		side: SideSales, prefix: "sales.order", label: "销售订单",
		headTable: "sal_order", itemTable: "sal_order_item",
		headResource: "salOrders", itemResource: "salOrderItems",
		itemOwnerType: "sal_order_item", numberResource: "sales.order",
		headDestroy: "destroySalOrder", itemDestroy: "destroySalOrderItem",
		auditMutation: "auditSalOrder", closeMutation: "closeSalOrder", voidMutation: "voidSalOrder",
		nonRegularType: OrderTypeSample, nonRegularSetting: "sample_item_max_qty",
		allowedParty: map[string]struct{}{"customer": {}, "company": {}},
	},
	SidePurchase: {
		side: SidePurchase, prefix: "purchase.order", label: "采购订单",
		headTable: "pur_order", itemTable: "pur_order_item",
		headResource: "purOrders", itemResource: "purOrderItems",
		itemOwnerType: "pur_order_item", numberResource: "purchase.order",
		headDestroy: "destroyPurOrder", itemDestroy: "destroyPurOrderItem",
		auditMutation: "auditPurOrder", closeMutation: "closePurOrder", voidMutation: "voidPurOrder",
		nonRegularType: OrderTypeSpot, nonRegularSetting: "spot_item_max_qty",
		allowedParty: map[string]struct{}{"supplier": {}, "company": {}},
	},
}

func specFor(side Side) (sideSpec, error) {
	spec, ok := specs[side]
	if !ok {
		return sideSpec{}, apierror.New(apierror.CodeValidation, "订单方向不合法")
	}
	return spec, nil
}

func mustSpec(side Side) sideSpec {
	spec, ok := specs[side]
	if !ok {
		panic("unknown order side: " + string(side))
	}
	return spec
}
