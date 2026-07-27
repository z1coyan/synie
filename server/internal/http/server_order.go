package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type orderHTTPService interface {
	ListOrders(context.Context, *authz.Actor, order.Side, order.ListQuery) (order.OrderListResult, error)
	GetOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error)
	CreateOrder(context.Context, *authz.Actor, order.Side, order.CreateOrderInput) (order.Order, error)
	UpdateOrder(context.Context, *authz.Actor, order.Side, uuid.UUID, order.UpdateOrderInput) (order.Order, error)
	DeleteOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) error
	AuditOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error)
	CloseOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error)
	VoidOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error)
	ListItems(context.Context, *authz.Actor, order.Side, order.ListQuery) (order.ItemListResult, error)
	GetItem(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Item, error)
	CreateItem(context.Context, *authz.Actor, order.Side, order.CreateItemInput) (order.Item, error)
	UpdateItem(context.Context, *authz.Actor, order.Side, uuid.UUID, order.UpdateItemInput) (order.Item, error)
	DeleteItem(context.Context, *authz.Actor, order.Side, uuid.UUID) error
	ListMaterials(context.Context, *authz.Actor, order.ListQuery) (order.MaterialListResult, error)
	GetMaterial(context.Context, *authz.Actor, uuid.UUID) (order.Material, error)
	CreateMaterial(context.Context, *authz.Actor, order.CreateMaterialInput) (order.Material, error)
	UpdateMaterial(context.Context, *authz.Actor, uuid.UUID, order.UpdateMaterialInput) (order.Material, error)
	DeleteMaterial(context.Context, *authz.Actor, uuid.UUID) error
	ListByproducts(context.Context, *authz.Actor, order.ListQuery) (order.ByproductListResult, error)
	GetByproduct(context.Context, *authz.Actor, uuid.UUID) (order.Byproduct, error)
	CreateByproduct(context.Context, *authz.Actor, order.CreateByproductInput) (order.Byproduct, error)
	UpdateByproduct(context.Context, *authz.Actor, uuid.UUID, order.UpdateByproductInput) (order.Byproduct, error)
	DeleteByproduct(context.Context, *authz.Actor, uuid.UUID) error
	ListDemandPool(context.Context, *authz.Actor, order.DemandPoolQuery) ([]order.DemandPoolItem, error)
	PreviewBOM(context.Context, *authz.Actor, uuid.UUID, decimal.Decimal) (order.BOMPreview, error)
	ListOrderFlow(context.Context, *authz.Actor, order.Side, uuid.UUID) ([]order.FlowItem, error)
}

func orderListQuery(body listBody) order.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return order.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) queryOrders(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side) {
	queryListAs(s, w, r, actor, orderListQuery,
		func(ctx context.Context, actor *authz.Actor, query order.ListQuery) (order.OrderListResult, error) {
			return s.Orders.ListOrders(ctx, actor, side, query)
		},
		func(result order.OrderListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results,
				func(item order.Order) map[string]any { return orderDTO(item, side) }))
		})
}

func (s *Server) getOrder(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	item, err := s.Orders.GetOrder(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderDTO(item, side))
}

func (s *Server) createOrder(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side) {
	var body gen.OrderCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	exchangeRate, err := optionalDecimalInput(body.ExchangeRate, orderLabel(side), "exchangeRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	isOutsourced := body.IsOutsourced != nil && *body.IsOutsourced
	item, err := s.Orders.CreateOrder(r.Context(), actor, side, order.CreateOrderInput{
		CompanyID: body.CompanyId, OrderNo: body.OrderNo, OrderDate: openAPIDatePointer(body.OrderDate),
		OrderType: order.OrderType(body.OrderType), IsOutsourced: isOutsourced,
		PartyType: string(body.PartyType), PartyID: body.PartyId, CurrencyID: body.CurrencyId,
		ExchangeRate: exchangeRate, Terms: body.Terms, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderDTO(item, side))
}

func (s *Server) updateOrder(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	var body struct {
		OrderNo      *string             `json:"orderNo,omitempty"`
		OrderDate    *openapi_types.Date `json:"orderDate,omitempty"`
		PartyType    *string             `json:"partyType,omitempty"`
		PartyID      *uuid.UUID          `json:"partyId,omitempty"`
		CurrencyID   *uuid.UUID          `json:"currencyId,omitempty"`
		ExchangeRate *string             `json:"exchangeRate,omitempty"`
		Terms        json.RawMessage     `json:"terms,omitempty"`
		Remarks      json.RawMessage     `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	exchangeRate, err := optionalDecimalInput(body.ExchangeRate, orderLabel(side), "exchangeRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	terms, err := optionalUpdate[string](body.Terms)
	if err != nil {
		s.writeError(w, r, nullableStringError(orderLabel(side), "terms"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError(orderLabel(side), "remarks"))
		return
	}
	item, err := s.Orders.UpdateOrder(r.Context(), actor, side, id, order.UpdateOrderInput{
		OrderNo: body.OrderNo, OrderDate: openAPIDatePointer(body.OrderDate),
		PartyType: body.PartyType, PartyID: body.PartyID, CurrencyID: body.CurrencyID,
		ExchangeRate: exchangeRate, Terms: terms, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderDTO(item, side))
}

func (s *Server) deleteOrder(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	if err := s.Orders.DeleteOrder(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) transitionOrder(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID, action string) {
	var item order.Order
	var err error
	switch action {
	case "audit":
		item, err = s.Orders.AuditOrder(r.Context(), actor, side, id)
	case "close":
		item, err = s.Orders.CloseOrder(r.Context(), actor, side, id)
	case "void":
		item, err = s.Orders.VoidOrder(r.Context(), actor, side, id)
	default:
		// 未知 action 必须显式拒绝:静默落入作废分支会把拼写错误变成作废单据
		s.writeError(w, r, apierror.Validation(orderLabel(side)+"操作不合法",
			map[string][]string{"action": {"不支持的动作: " + action}}))
		return
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderDTO(item, side))
}

func (s *Server) queryOrderItems(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side) {
	queryListAs(s, w, r, actor, orderListQuery,
		func(ctx context.Context, actor *authz.Actor, query order.ListQuery) (order.ItemListResult, error) {
			return s.Orders.ListItems(ctx, actor, side, query)
		},
		func(result order.ItemListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results,
				func(item order.Item) map[string]any { return orderItemDTO(item, side) }))
		})
}

func (s *Server) getOrderItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	item, err := s.Orders.GetItem(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderItemDTO(item, side))
}

func (s *Server) createOrderItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side) {
	var body gen.OrderItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, orderItemLabel(side), "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	price, err := optionalDecimalInput(body.Price, orderItemLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	taxRate, err := optionalDecimalInput(body.TaxRate, orderItemLabel(side), "taxRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Orders.CreateItem(r.Context(), actor, side, order.CreateItemInput{
		OrderID: body.OrderId, Idx: body.Idx, Qty: qty, MaterialID: body.MaterialId,
		UnitID: body.UnitId, Price: price, TaxRate: taxRate, Remarks: body.Remarks,
		QuotationItemID: body.QuotationItemId, BOMID: body.BomId, DemandLineID: body.DemandLineId,
		DemandDate: openAPIDatePointer(body.DemandDate),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderItemDTO(item, side))
}

func (s *Server) updateOrderItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	var body struct {
		Idx             *int64          `json:"idx,omitempty"`
		Qty             *string         `json:"qty,omitempty"`
		MaterialID      *uuid.UUID      `json:"materialId,omitempty"`
		UnitID          *uuid.UUID      `json:"unitId,omitempty"`
		Price           *string         `json:"price,omitempty"`
		TaxRate         *string         `json:"taxRate,omitempty"`
		Remarks         json.RawMessage `json:"remarks,omitempty"`
		QuotationItemID json.RawMessage `json:"quotationItemId,omitempty"`
		BOMID           json.RawMessage `json:"bomId,omitempty"`
		DemandLineID    json.RawMessage `json:"demandLineId,omitempty"`
		DemandDate      json.RawMessage `json:"demandDate,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, orderItemLabel(side), "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	price, err := optionalDecimalInput(body.Price, orderItemLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	taxRate, err := optionalDecimalInput(body.TaxRate, orderItemLabel(side), "taxRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError(orderItemLabel(side), "remarks"))
		return
	}
	quotationItemID, err := optionalUpdate[uuid.UUID](body.QuotationItemID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError(orderItemLabel(side), "quotationItemId"))
		return
	}
	bomID, err := optionalUpdate[uuid.UUID](body.BOMID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError(orderItemLabel(side), "bomId"))
		return
	}
	demandLineID, err := optionalUpdate[uuid.UUID](body.DemandLineID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError(orderItemLabel(side), "demandLineId"))
		return
	}
	demandDate, err := optionalDateUpdate(body.DemandDate)
	if err != nil {
		s.writeError(w, r, apierror.Validation(orderItemLabel(side)+"参数不合法", map[string][]string{"demandDate": {"必须是日期或 null"}}))
		return
	}
	item, err := s.Orders.UpdateItem(r.Context(), actor, side, id, order.UpdateItemInput{
		Idx: body.Idx, Qty: qty, MaterialID: body.MaterialID, UnitID: body.UnitID,
		Price: price, TaxRate: taxRate, Remarks: remarks, QuotationItemID: quotationItemID,
		BOMID: bomID, DemandLineID: demandLineID, DemandDate: demandDate,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderItemDTO(item, side))
}

func (s *Server) deleteOrderItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	if err := s.Orders.DeleteItem(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func orderLabel(side order.Side) string {
	if side == order.SideSales {
		return "销售订单"
	}
	return "采购订单"
}

func orderItemLabel(side order.Side) string {
	if side == order.SideSales {
		return "销售订单条目"
	}
	return "采购订单条目"
}

func orderDTO(item order.Order, side order.Side) map[string]any {
	result := map[string]any{
		"id": item.ID, "orderNo": item.OrderNo, "orderDate": item.OrderDate.Format("2006-01-02"),
		"orderType": item.OrderType, "partyType": item.PartyType, "partyId": item.PartyID,
		"exchangeRate": item.ExchangeRate.String(), "terms": item.Terms, "remarks": item.Remarks,
		"status": item.Status, "auditedAt": item.AuditedAt, "insertedAt": item.InsertedAt,
		"updatedAt": item.UpdatedAt, "companyId": item.CompanyID, "currencyId": item.CurrencyID,
		"createdById": item.CreatedByID, "auditedById": item.AuditedByID,
		"grossTotal": item.GrossTotal.String(), "baseGrossTotal": item.BaseGrossTotal.String(),
		"company": item.Company, "currency": item.Currency, "createdBy": item.CreatedBy, "auditedBy": item.AuditedBy,
	}
	if side == order.SidePurchase {
		result["isOutsourced"] = item.IsOutsourced
	}
	return result
}

func orderItemDTO(item order.Item, side order.Side) map[string]any {
	result := map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(), "baseQty": item.BaseQty.String(),
		"price": item.Price.String(), "amount": item.Amount.String(), "basePrice": item.BasePrice.String(),
		"baseAmount": item.BaseAmount.String(), "taxRate": item.TaxRate.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "customerPartNo": item.CustomerPartNo,
		"unitName": item.UnitName, "remarks": item.Remarks, "insertedAt": item.InsertedAt,
		"updatedAt": item.UpdatedAt, "orderId": item.OrderID, "companyId": item.CompanyID,
		"materialId": item.MaterialID, "unitId": item.UnitID, "quotationItemId": item.QuotationItemID,
		"pricingMode": item.PricingMode, "orderNo": item.OrderNo,
		"orderDate": item.OrderDate.Format("2006-01-02"), "orderStatus": item.OrderStatus,
		"partyType": item.PartyType, "partyId": item.PartyID, "currencyCode": item.CurrencyCode,
		"remainingBaseQty": item.RemainingBaseQty.String(), "order": item.Order,
		"company": item.Company, "material": item.Material, "unit": item.Unit,
	}
	if side == order.SideSales {
		result["shippedQty"] = item.ShippedQty.String()
	} else {
		result["receivedQty"] = item.ReceivedQty.String()
		result["bomId"] = item.BOMID
		result["bomCode"] = item.BOMCode
		result["bomPlanName"] = item.BOMPlanName
		result["demandLineId"] = item.DemandLineID
		result["demandNo"] = item.DemandNo
		result["demandDate"] = dateOnly(item.DemandDate)
		result["orderIsOutsourced"] = item.OrderIsOutsourced
	}
	return result
}

func dateOnly(value *time.Time) *string {
	if value == nil {
		return nil
	}
	result := value.Format("2006-01-02")
	return &result
}
