package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestOrderHandlersAuthorizeBeforeDecodeOrService(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		name, method, permission string
		handler                  http.HandlerFunc
	}{
		{"query sales orders", http.MethodPost, "sales.order:read", server.QuerySalesOrders},
		{"get sales order", http.MethodGet, "sales.order:read", withID(server.GetSalesOrder)},
		{"create sales order", http.MethodPost, "sales.order:create", server.CreateSalesOrder},
		{"update sales order", http.MethodPatch, "sales.order:update", withID(server.UpdateSalesOrder)},
		{"delete sales order", http.MethodDelete, "sales.order:delete", withID(server.DeleteSalesOrder)},
		{"audit sales order", http.MethodPost, "sales.order:audit", withID(server.AuditSalesOrder)},
		{"close sales order", http.MethodPost, "sales.order:close", withID(server.CloseSalesOrder)},
		{"void sales order", http.MethodPost, "sales.order:void", withID(server.VoidSalesOrder)},
		{"sales order history", http.MethodGet, "sales.order:read", withID(server.GetSalesOrderHistory)},
		{"query sales items", http.MethodPost, "sales.order:read", server.QuerySalesOrderItems},
		{"get sales item", http.MethodGet, "sales.order:read", withID(server.GetSalesOrderItem)},
		{"create sales item", http.MethodPost, "sales.order:create", server.CreateSalesOrderItem},
		{"update sales item", http.MethodPatch, "sales.order:update", withID(server.UpdateSalesOrderItem)},
		{"delete sales item", http.MethodDelete, "sales.order:delete", withID(server.DeleteSalesOrderItem)},
		{"query purchase orders", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrders},
		{"get purchase order", http.MethodGet, "purchase.order:read", withID(server.GetPurchaseOrder)},
		{"create purchase order", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrder},
		{"update purchase order", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrder)},
		{"delete purchase order", http.MethodDelete, "purchase.order:delete", withID(server.DeletePurchaseOrder)},
		{"audit purchase order", http.MethodPost, "purchase.order:audit", withID(server.AuditPurchaseOrder)},
		{"close purchase order", http.MethodPost, "purchase.order:close", withID(server.ClosePurchaseOrder)},
		{"void purchase order", http.MethodPost, "purchase.order:void", withID(server.VoidPurchaseOrder)},
		{"purchase order history", http.MethodGet, "purchase.order:read", withID(server.GetPurchaseOrderHistory)},
		{"query purchase items", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItems},
		{"get purchase item", http.MethodGet, "purchase.order:read", withID(server.GetPurchaseOrderItem)},
		{"create purchase item", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItem},
		{"update purchase item", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItem)},
		{"delete purchase item", http.MethodDelete, "purchase.order:delete", withID(server.DeletePurchaseOrderItem)},
		{"query materials", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItemMaterials},
		{"get material", http.MethodGet, "purchase.order:read", withID(server.GetPurchaseOrderItemMaterial)},
		{"create material", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItemMaterial},
		{"update material", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItemMaterial)},
		{"delete material", http.MethodDelete, "purchase.order:delete", withID(server.DeletePurchaseOrderItemMaterial)},
		{"query byproducts", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItemByproducts},
		{"get byproduct", http.MethodGet, "purchase.order:read", withID(server.GetPurchaseOrderItemByproduct)},
		{"create byproduct", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItemByproduct},
		{"update byproduct", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItemByproduct)},
		{"delete byproduct", http.MethodDelete, "purchase.order:delete", withID(server.DeletePurchaseOrderItemByproduct)},
		{"demand pool", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderDemandLines},
		{"BOM preview", http.MethodPost, "purchase.order:read", server.ExpandPurchaseOrderBom},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, inventoryRequest(tc.method, "{", nil))
			if response.Code != http.StatusForbidden {
				t.Fatalf("without %s status=%d body=%s", tc.permission, response.Code, response.Body.String())
			}
		})
	}
}

func TestOrderBodyHandlersAuthorizeBeforeJSONValidation(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		name, method, permission string
		handler                  http.HandlerFunc
	}{
		{"query sales orders", http.MethodPost, "sales.order:read", server.QuerySalesOrders},
		{"create sales order", http.MethodPost, "sales.order:create", server.CreateSalesOrder},
		{"update sales order", http.MethodPatch, "sales.order:update", withID(server.UpdateSalesOrder)},
		{"query sales items", http.MethodPost, "sales.order:read", server.QuerySalesOrderItems},
		{"create sales item", http.MethodPost, "sales.order:create", server.CreateSalesOrderItem},
		{"update sales item", http.MethodPatch, "sales.order:update", withID(server.UpdateSalesOrderItem)},
		{"query purchase orders", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrders},
		{"create purchase order", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrder},
		{"update purchase order", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrder)},
		{"query purchase items", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItems},
		{"create purchase item", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItem},
		{"update purchase item", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItem)},
		{"query materials", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItemMaterials},
		{"create material", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItemMaterial},
		{"update material", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItemMaterial)},
		{"query byproducts", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderItemByproducts},
		{"create byproduct", http.MethodPost, "purchase.order:create", server.CreatePurchaseOrderItemByproduct},
		{"update byproduct", http.MethodPatch, "purchase.order:update", withID(server.UpdatePurchaseOrderItemByproduct)},
		{"demand pool", http.MethodPost, "purchase.order:read", server.QueryPurchaseOrderDemandLines},
		{"BOM preview", http.MethodPost, "purchase.order:read", server.ExpandPurchaseOrderBom},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, inventoryRequest(tc.method, "{", map[string]struct{}{tc.permission: {}}))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

type transitionOrderStub struct {
	orderHTTPService
	audited, closed, voided int
}

func (s *transitionOrderStub) AuditOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error) {
	s.audited++
	return order.Order{}, nil
}

func (s *transitionOrderStub) CloseOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error) {
	s.closed++
	return order.Order{}, nil
}

func (s *transitionOrderStub) VoidOrder(context.Context, *authz.Actor, order.Side, uuid.UUID) (order.Order, error) {
	s.voided++
	return order.Order{}, nil
}

func TestTransitionOrderRejectsUnknownActionWithoutTouchingService(t *testing.T) {
	stub := &transitionOrderStub{}
	server := &Server{orders: stub}
	response := httptest.NewRecorder()
	server.transitionOrder(response, inventoryRequest(http.MethodPost, "", nil),
		order.SideSales, uuid.New(), "audi")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown action status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "audi") {
		t.Fatalf("unknown action body=%s", response.Body.String())
	}
	if stub.audited != 0 || stub.closed != 0 || stub.voided != 0 {
		t.Fatalf("unknown action reached service: audited=%d closed=%d voided=%d",
			stub.audited, stub.closed, stub.voided)
	}
}

func TestTransitionOrderDispatchesKnownActions(t *testing.T) {
	stub := &transitionOrderStub{}
	server := &Server{orders: stub}
	id := uuid.New()
	for _, action := range []string{"audit", "close", "void"} {
		response := httptest.NewRecorder()
		server.transitionOrder(response, inventoryRequest(http.MethodPost, "", nil),
			order.SideSales, id, action)
		if response.Code != http.StatusOK {
			t.Fatalf("action %s status=%d body=%s", action, response.Code, response.Body.String())
		}
	}
	if stub.audited != 1 || stub.closed != 1 || stub.voided != 1 {
		t.Fatalf("dispatch counts audited=%d closed=%d voided=%d", stub.audited, stub.closed, stub.voided)
	}
}

func TestOrderDTOUsesDateOnlyAndDecimalStrings(t *testing.T) {
	date := time.Date(2026, 7, 26, 15, 30, 0, 0, time.UTC)
	head := orderDTO(order.Order{
		OrderDate: date, ExchangeRate: decimal.RequireFromString("7.2000"),
		GrossTotal: decimal.RequireFromString("12.3400"), BaseGrossTotal: decimal.RequireFromString("88.8480"),
	}, order.SidePurchase)
	if head["orderDate"] != "2026-07-26" || head["exchangeRate"] != "7.2" ||
		head["grossTotal"] != "12.34" || head["baseGrossTotal"] != "88.848" {
		t.Fatalf("head wire values=%#v", head)
	}
	item := orderItemDTO(order.Item{
		OrderDate: date, DemandDate: &date, Qty: decimal.RequireFromString("2.5000"),
		RemainingBaseQty: decimal.RequireFromString("1.2500"),
	}, order.SidePurchase)
	if item["orderDate"] != "2026-07-26" || *(item["demandDate"].(*string)) != "2026-07-26" ||
		item["qty"] != "2.5" || item["remainingBaseQty"] != "1.25" {
		t.Fatalf("item wire values=%#v", item)
	}
}
