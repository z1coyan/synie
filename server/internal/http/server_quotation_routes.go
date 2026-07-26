package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
)

func (s *Server) authorizeQuotation(w http.ResponseWriter, r *http.Request, side quotation.Side, action string) bool {
	if _, err := actorWithPermission(r, quotationPermission(side, action)); err != nil {
		s.writeError(w, r, err)
		return false
	}
	return true
}

func (s *Server) QuerySalesQuotations(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.queryQuotations(w, r, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.getQuotation(w, r, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotation(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "create") {
		s.createQuotation(w, r, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "update") {
		s.updateQuotation(w, r, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "delete") {
		s.deleteQuotation(w, r, quotation.SideSales, id)
	}
}

func (s *Server) AuditSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "audit") {
		s.auditQuotation(w, r, quotation.SideSales, id)
	}
}

func (s *Server) VoidSalesQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "void") {
		s.voidQuotation(w, r, quotation.SideSales, id)
	}
}

func (s *Server) QuerySalesQuotationItems(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.queryQuotationItems(w, r, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.getQuotationItem(w, r, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotationItem(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "create") {
		s.createQuotationItem(w, r, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "update") {
		s.updateQuotationItem(w, r, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "delete") {
		s.deleteQuotationItem(w, r, quotation.SideSales, id)
	}
}

func (s *Server) QuerySalesQuotationTiers(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.queryQuotationTiers(w, r, quotation.SideSales)
	}
}

func (s *Server) GetSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "read") {
		s.getQuotationTier(w, r, quotation.SideSales, id)
	}
}

func (s *Server) CreateSalesQuotationTier(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "create") {
		s.createQuotationTier(w, r, quotation.SideSales)
	}
}

func (s *Server) UpdateSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "update") {
		s.updateQuotationTier(w, r, quotation.SideSales, id)
	}
}

func (s *Server) DeleteSalesQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SideSales, "delete") {
		s.deleteQuotationTier(w, r, quotation.SideSales, id)
	}
}

func (s *Server) QueryPurchaseQuotations(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.queryQuotations(w, r, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.getQuotation(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotation(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "create") {
		s.createQuotation(w, r, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "update") {
		s.updateQuotation(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "delete") {
		s.deleteQuotation(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) AuditPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "audit") {
		s.auditQuotation(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) VoidPurchaseQuotation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "void") {
		s.voidQuotation(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseQuotationItems(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.queryQuotationItems(w, r, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.getQuotationItem(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotationItem(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "create") {
		s.createQuotationItem(w, r, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "update") {
		s.updateQuotationItem(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "delete") {
		s.deleteQuotationItem(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) QueryPurchaseQuotationTiers(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.queryQuotationTiers(w, r, quotation.SidePurchase)
	}
}

func (s *Server) GetPurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "read") {
		s.getQuotationTier(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseQuotationTier(w http.ResponseWriter, r *http.Request) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "create") {
		s.createQuotationTier(w, r, quotation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "update") {
		s.updateQuotationTier(w, r, quotation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseQuotationTier(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if s.authorizeQuotation(w, r, quotation.SidePurchase, "delete") {
		s.deleteQuotationTier(w, r, quotation.SidePurchase, id)
	}
}
