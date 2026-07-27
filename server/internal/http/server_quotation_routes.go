package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// authorizeQuotation 是路由门面的唯一鉴权点:鉴权通过后把 actor 显式传给内部实现函数。
func (s *Server) authorizeQuotation(
	w http.ResponseWriter, r *http.Request, side quotation.Side, action string,
) *authz.Actor {
	actor, err := actorWithPermission(r, quotationPermission(side, action))
	if err != nil {
		s.writeError(w, r, err)
		return nil
	}
	return actor
}

func (s *Server) QuerySalesQuotations(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.queryQuotations(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.getQuotation(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotation(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "create"); actor != nil {
		s.createQuotation(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "update"); actor != nil {
		s.updateQuotation(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "delete"); actor != nil {
		s.deleteQuotation(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) AuditSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "audit"); actor != nil {
		s.auditQuotation(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) VoidSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "void"); actor != nil {
		s.voidQuotation(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) QuerySalesQuotationItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.queryQuotationItems(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.getQuotationItem(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotationItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "create"); actor != nil {
		s.createQuotationItem(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "update"); actor != nil {
		s.updateQuotationItem(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "delete"); actor != nil {
		s.deleteQuotationItem(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) QuerySalesQuotationTiers(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.queryQuotationTiers(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "read"); actor != nil {
		s.getQuotationTier(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotationTier(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "create"); actor != nil {
		s.createQuotationTier(w, r, actor, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "update"); actor != nil {
		s.updateQuotationTier(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SideSales, "delete"); actor != nil {
		s.deleteQuotationTier(w, r, actor, quotation.SideSales, id)
	}
}

func (s *Server) QueryPurchaseQuotations(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.queryQuotations(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.getQuotation(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotation(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "create"); actor != nil {
		s.createQuotation(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "update"); actor != nil {
		s.updateQuotation(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "delete"); actor != nil {
		s.deleteQuotation(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) AuditPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "audit"); actor != nil {
		s.auditQuotation(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) VoidPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "void"); actor != nil {
		s.voidQuotation(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseQuotationItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.queryQuotationItems(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.getQuotationItem(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotationItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "create"); actor != nil {
		s.createQuotationItem(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "update"); actor != nil {
		s.updateQuotationItem(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "delete"); actor != nil {
		s.deleteQuotationItem(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseQuotationTiers(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.queryQuotationTiers(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "read"); actor != nil {
		s.getQuotationTier(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotationTier(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "create"); actor != nil {
		s.createQuotationTier(w, r, actor, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "update"); actor != nil {
		s.updateQuotationTier(w, r, actor, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeQuotation(w, r, quotation.SidePurchase, "delete"); actor != nil {
		s.deleteQuotationTier(w, r, actor, quotation.SidePurchase, id)
	}
}
