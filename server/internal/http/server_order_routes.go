package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
)

func orderPermission(side order.Side, action string) string {
	if side == order.SideSales {
		return "sales.order:" + action
	}
	return "purchase.order:" + action
}

func (s *Server) authorizeOrder(w http.ResponseWriter, r *http.Request, side order.Side, action string) bool {
	if _, err := actorWithPermission(r, orderPermission(side, action)); err != nil {
		s.writeError(w, r, err)
		return false
	}
	return true
}

func (s *Server) QuerySalesOrders(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SideSales, "read") {
		s.queryOrders(w, r, order.SideSales)
	}
}
func (s *Server) GetSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "read") {
		s.getOrder(w, r, order.SideSales, id)
	}
}
func (s *Server) CreateSalesOrder(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SideSales, "create") {
		s.createOrder(w, r, order.SideSales)
	}
}
func (s *Server) UpdateSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "update") {
		s.updateOrder(w, r, order.SideSales, id)
	}
}
func (s *Server) DeleteSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "delete") {
		s.deleteOrder(w, r, order.SideSales, id)
	}
}
func (s *Server) AuditSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "audit") {
		s.transitionOrder(w, r, order.SideSales, id, "audit")
	}
}
func (s *Server) CloseSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "close") {
		s.transitionOrder(w, r, order.SideSales, id, "close")
	}
}
func (s *Server) VoidSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "void") {
		s.transitionOrder(w, r, order.SideSales, id, "void")
	}
}
func (s *Server) GetSalesOrderHistory(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "read") {
		s.getOrderHistory(w, r, order.SideSales, id)
	}
}
func (s *Server) QuerySalesOrderItems(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SideSales, "read") {
		s.queryOrderItems(w, r, order.SideSales)
	}
}
func (s *Server) GetSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "read") {
		s.getOrderItem(w, r, order.SideSales, id)
	}
}
func (s *Server) CreateSalesOrderItem(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SideSales, "create") {
		s.createOrderItem(w, r, order.SideSales)
	}
}
func (s *Server) UpdateSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "update") {
		s.updateOrderItem(w, r, order.SideSales, id)
	}
}
func (s *Server) DeleteSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SideSales, "delete") {
		s.deleteOrderItem(w, r, order.SideSales, id)
	}
}

func (s *Server) QueryPurchaseOrders(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.queryOrders(w, r, order.SidePurchase)
	}
}
func (s *Server) GetPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.getOrder(w, r, order.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "create") {
		s.createOrder(w, r, order.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "update") {
		s.updateOrder(w, r, order.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "delete") {
		s.deleteOrder(w, r, order.SidePurchase, id)
	}
}
func (s *Server) AuditPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "audit") {
		s.transitionOrder(w, r, order.SidePurchase, id, "audit")
	}
}
func (s *Server) ClosePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "close") {
		s.transitionOrder(w, r, order.SidePurchase, id, "close")
	}
}
func (s *Server) VoidPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "void") {
		s.transitionOrder(w, r, order.SidePurchase, id, "void")
	}
}
func (s *Server) GetPurchaseOrderHistory(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.getOrderHistory(w, r, order.SidePurchase, id)
	}
}
func (s *Server) QueryPurchaseOrderItems(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.queryOrderItems(w, r, order.SidePurchase)
	}
}
func (s *Server) GetPurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.getOrderItem(w, r, order.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseOrderItem(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "create") {
		s.createOrderItem(w, r, order.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "update") {
		s.updateOrderItem(w, r, order.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "delete") {
		s.deleteOrderItem(w, r, order.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseOrderItemMaterials(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.queryOrderMaterials(w, r)
	}
}
func (s *Server) GetPurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.getOrderMaterial(w, r, id)
	}
}
func (s *Server) CreatePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "create") {
		s.createOrderMaterial(w, r)
	}
}
func (s *Server) UpdatePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "update") {
		s.updateOrderMaterial(w, r, id)
	}
}
func (s *Server) DeletePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "delete") {
		s.deleteOrderMaterial(w, r, id)
	}
}
func (s *Server) QueryPurchaseOrderItemByproducts(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.queryOrderByproducts(w, r)
	}
}
func (s *Server) GetPurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.getOrderByproduct(w, r, id)
	}
}
func (s *Server) CreatePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "create") {
		s.createOrderByproduct(w, r)
	}
}
func (s *Server) UpdatePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "update") {
		s.updateOrderByproduct(w, r, id)
	}
}
func (s *Server) DeletePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeOrder(w, r, order.SidePurchase, "delete") {
		s.deleteOrderByproduct(w, r, id)
	}
}
func (s *Server) QueryPurchaseOrderDemandLines(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.queryOrderDemandPool(w, r)
	}
}
func (s *Server) ExpandPurchaseOrderBom(w http.ResponseWriter, r *http.Request) {
	if s.authorizeOrder(w, r, order.SidePurchase, "read") {
		s.previewOrderBOM(w, r)
	}
}
