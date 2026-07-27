package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func orderPermission(side order.Side, action string) string {
	if side == order.SideSales {
		return "sales.order:" + action
	}
	return "purchase.order:" + action
}

// authorizeOrder 是路由门面的唯一鉴权点:鉴权通过后把 actor 显式传给内部实现函数。
func (s *Server) authorizeOrder(
	w http.ResponseWriter, r *http.Request, side order.Side, action string,
) *authz.Actor {
	actor, err := actorWithPermission(r, orderPermission(side, action))
	if err != nil {
		s.writeError(w, r, err)
		return nil
	}
	return actor
}

func (s *Server) QuerySalesOrders(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "read"); actor != nil {
		s.queryOrders(w, r, actor, order.SideSales)
	}
}
func (s *Server) GetSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "read"); actor != nil {
		s.getOrder(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) CreateSalesOrder(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "create"); actor != nil {
		s.createOrder(w, r, actor, order.SideSales)
	}
}
func (s *Server) UpdateSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "update"); actor != nil {
		s.updateOrder(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) DeleteSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "delete"); actor != nil {
		s.deleteOrder(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) AuditSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "audit"); actor != nil {
		s.transitionOrder(w, r, actor, order.SideSales, id, "audit")
	}
}
func (s *Server) CloseSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "close"); actor != nil {
		s.transitionOrder(w, r, actor, order.SideSales, id, "close")
	}
}
func (s *Server) VoidSalesOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "void"); actor != nil {
		s.transitionOrder(w, r, actor, order.SideSales, id, "void")
	}
}
func (s *Server) GetSalesOrderHistory(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "read"); actor != nil {
		s.getOrderHistory(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) QuerySalesOrderItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "read"); actor != nil {
		s.queryOrderItems(w, r, actor, order.SideSales)
	}
}
func (s *Server) GetSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "read"); actor != nil {
		s.getOrderItem(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) CreateSalesOrderItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "create"); actor != nil {
		s.createOrderItem(w, r, actor, order.SideSales)
	}
}
func (s *Server) UpdateSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "update"); actor != nil {
		s.updateOrderItem(w, r, actor, order.SideSales, id)
	}
}
func (s *Server) DeleteSalesOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SideSales, "delete"); actor != nil {
		s.deleteOrderItem(w, r, actor, order.SideSales, id)
	}
}

func (s *Server) QueryPurchaseOrders(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.queryOrders(w, r, actor, order.SidePurchase)
	}
}
func (s *Server) GetPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.getOrder(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "create"); actor != nil {
		s.createOrder(w, r, actor, order.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "update"); actor != nil {
		s.updateOrder(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "delete"); actor != nil {
		s.deleteOrder(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) AuditPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "audit"); actor != nil {
		s.transitionOrder(w, r, actor, order.SidePurchase, id, "audit")
	}
}
func (s *Server) ClosePurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "close"); actor != nil {
		s.transitionOrder(w, r, actor, order.SidePurchase, id, "close")
	}
}
func (s *Server) VoidPurchaseOrder(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "void"); actor != nil {
		s.transitionOrder(w, r, actor, order.SidePurchase, id, "void")
	}
}
func (s *Server) GetPurchaseOrderHistory(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.getOrderHistory(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) QueryPurchaseOrderItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.queryOrderItems(w, r, actor, order.SidePurchase)
	}
}
func (s *Server) GetPurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.getOrderItem(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseOrderItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "create"); actor != nil {
		s.createOrderItem(w, r, actor, order.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "update"); actor != nil {
		s.updateOrderItem(w, r, actor, order.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseOrderItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "delete"); actor != nil {
		s.deleteOrderItem(w, r, actor, order.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseOrderItemMaterials(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.queryOrderMaterials(w, r, actor)
	}
}
func (s *Server) GetPurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.getOrderMaterial(w, r, actor, id)
	}
}
func (s *Server) CreatePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "create"); actor != nil {
		s.createOrderMaterial(w, r, actor)
	}
}
func (s *Server) UpdatePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "update"); actor != nil {
		s.updateOrderMaterial(w, r, actor, id)
	}
}
func (s *Server) DeletePurchaseOrderItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "delete"); actor != nil {
		s.deleteOrderMaterial(w, r, actor, id)
	}
}
func (s *Server) QueryPurchaseOrderItemByproducts(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.queryOrderByproducts(w, r, actor)
	}
}
func (s *Server) GetPurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.getOrderByproduct(w, r, actor, id)
	}
}
func (s *Server) CreatePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "create"); actor != nil {
		s.createOrderByproduct(w, r, actor)
	}
}
func (s *Server) UpdatePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "update"); actor != nil {
		s.updateOrderByproduct(w, r, actor, id)
	}
}
func (s *Server) DeletePurchaseOrderItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "delete"); actor != nil {
		s.deleteOrderByproduct(w, r, actor, id)
	}
}
func (s *Server) QueryPurchaseOrderDemandLines(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.queryOrderDemandPool(w, r, actor)
	}
}
func (s *Server) ExpandPurchaseOrderBom(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeOrder(w, r, order.SidePurchase, "read"); actor != nil {
		s.previewOrderBOM(w, r, actor)
	}
}
