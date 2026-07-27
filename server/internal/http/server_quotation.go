package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type quotationHeadHTTPService interface {
	ListQuotations(context.Context, *authz.Actor, quotation.Side, quotation.ListQuery) (quotation.QuotationListResult, error)
	GetQuotation(context.Context, *authz.Actor, quotation.Side, uuid.UUID) (quotation.Quotation, error)
	CreateQuotation(context.Context, *authz.Actor, quotation.Side, quotation.CreateQuotationInput) (quotation.Quotation, error)
	UpdateQuotation(context.Context, *authz.Actor, quotation.Side, uuid.UUID, quotation.UpdateQuotationInput) (quotation.Quotation, error)
	DeleteQuotation(context.Context, *authz.Actor, quotation.Side, uuid.UUID) error
	AuditQuotation(context.Context, *authz.Actor, quotation.Side, uuid.UUID) (quotation.Quotation, error)
	VoidQuotation(context.Context, *authz.Actor, quotation.Side, uuid.UUID) (quotation.Quotation, error)
}

type quotationItemHTTPService interface {
	ListItems(context.Context, *authz.Actor, quotation.Side, quotation.ListQuery) (quotation.ItemListResult, error)
	GetItem(context.Context, *authz.Actor, quotation.Side, uuid.UUID) (quotation.Item, error)
	CreateItem(context.Context, *authz.Actor, quotation.Side, quotation.CreateItemInput) (quotation.Item, error)
	UpdateItem(context.Context, *authz.Actor, quotation.Side, uuid.UUID, quotation.UpdateItemInput) (quotation.Item, error)
	DeleteItem(context.Context, *authz.Actor, quotation.Side, uuid.UUID) error
}

type quotationTierHTTPService interface {
	ListTiers(context.Context, *authz.Actor, quotation.Side, quotation.ListQuery) (quotation.TierListResult, error)
	GetTier(context.Context, *authz.Actor, quotation.Side, uuid.UUID) (quotation.Tier, error)
	CreateTier(context.Context, *authz.Actor, quotation.Side, quotation.CreateTierInput) (quotation.Tier, error)
	UpdateTier(context.Context, *authz.Actor, quotation.Side, uuid.UUID, quotation.UpdateTierInput) (quotation.Tier, error)
	DeleteTier(context.Context, *authz.Actor, quotation.Side, uuid.UUID) error
}

type quotationHTTPService interface {
	quotationHeadHTTPService
	quotationItemHTTPService
	quotationTierHTTPService
}

var _ quotationHTTPService = (*quotation.Service)(nil)

func quotationPermission(side quotation.Side, action string) string {
	if side == quotation.SideSales {
		return "sales.quotation:" + action
	}
	return "purchase.quotation:" + action
}

func quotationListQuery(body listBody) quotation.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return quotation.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) queryQuotations(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side,
) {
	queryListAs(s, w, r, actor, quotationListQuery,
		func(ctx context.Context, actor *authz.Actor, query quotation.ListQuery) (quotation.QuotationListResult, error) {
			return s.Quotations.ListQuotations(ctx, actor, side, query)
		},
		func(result quotation.QuotationListResult) any { return quotationListDTO(result) })
}

func (s *Server) getQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	item, err := s.Quotations.GetQuotation(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationDTO(item))
}

func (s *Server) createQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side) {
	var body gen.QuotationCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.Quotations.CreateQuotation(r.Context(), actor, side, quotation.CreateQuotationInput{
		CompanyID: body.CompanyId, QuotationNo: body.QuotationNo,
		QuotationDate: datePointer(body.QuotationDate), ValidUntil: body.ValidUntil.Time,
		PartyType: string(body.PartyType), PartyID: body.PartyId,
		CurrencyID: body.CurrencyId, Terms: body.Terms, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, quotationDTO(item))
}

func (s *Server) updateQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	var body struct {
		QuotationNo   *string             `json:"quotationNo,omitempty"`
		QuotationDate *openapi_types.Date `json:"quotationDate,omitempty"`
		ValidUntil    *openapi_types.Date `json:"validUntil,omitempty"`
		PartyType     *string             `json:"partyType,omitempty"`
		PartyID       *uuid.UUID          `json:"partyId,omitempty"`
		CurrencyID    *uuid.UUID          `json:"currencyId,omitempty"`
		Terms         json.RawMessage     `json:"terms,omitempty"`
		Remarks       json.RawMessage     `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	terms, err := nullableStringUpdate(body.Terms)
	if err != nil {
		s.writeError(w, r, nullableStringError(quotationLabel(side), "terms"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError(quotationLabel(side), "remarks"))
		return
	}
	item, err := s.Quotations.UpdateQuotation(r.Context(), actor, side, id, quotation.UpdateQuotationInput{
		QuotationNo: body.QuotationNo, QuotationDate: openAPIDatePointer(body.QuotationDate),
		ValidUntil: openAPIDatePointer(body.ValidUntil), PartyType: body.PartyType,
		PartyID: body.PartyID, CurrencyID: body.CurrencyID, Terms: terms, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationDTO(item))
}

func (s *Server) deleteQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	if err := s.Quotations.DeleteQuotation(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) auditQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	item, err := s.Quotations.AuditQuotation(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationDTO(item))
}

func (s *Server) voidQuotation(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	item, err := s.Quotations.VoidQuotation(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationDTO(item))
}

func (s *Server) queryQuotationItems(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side,
) {
	queryListAs(s, w, r, actor, quotationListQuery,
		func(ctx context.Context, actor *authz.Actor, query quotation.ListQuery) (quotation.ItemListResult, error) {
			return s.Quotations.ListItems(ctx, actor, side, query)
		},
		func(result quotation.ItemListResult) any { return quotationItemListDTO(result) })
}

func (s *Server) getQuotationItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	item, err := s.Quotations.GetItem(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationItemDTO(item))
}

func (s *Server) createQuotationItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side) {
	var body gen.QuotationItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	price, err := optionalDecimalInput(body.Price, quotationItemLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	taxRate, err := optionalDecimalInput(body.TaxRate, quotationItemLabel(side), "taxRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	mode := quotation.PricingFixed
	if body.PricingMode != nil {
		mode = quotation.PricingMode(*body.PricingMode)
	}
	item, err := s.Quotations.CreateItem(r.Context(), actor, side, quotation.CreateItemInput{
		QuotationID: body.QuotationId, Idx: body.Idx,
		MaterialID: body.MaterialId, UnitID: body.UnitId, PricingMode: mode,
		Price: price, TaxRate: taxRate, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, quotationItemDTO(item))
}

func (s *Server) updateQuotationItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	var body struct {
		Idx         *int64          `json:"idx,omitempty"`
		MaterialID  *uuid.UUID      `json:"materialId,omitempty"`
		UnitID      *uuid.UUID      `json:"unitId,omitempty"`
		PricingMode *string         `json:"pricingMode,omitempty"`
		Price       json.RawMessage `json:"price,omitempty"`
		TaxRate     *string         `json:"taxRate,omitempty"`
		Remarks     json.RawMessage `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	price, err := nullableDecimalUpdate(body.Price, quotationItemLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	taxRate, err := optionalDecimalInput(body.TaxRate, quotationItemLabel(side), "taxRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError(quotationItemLabel(side), "remarks"))
		return
	}
	var mode *quotation.PricingMode
	if body.PricingMode != nil {
		value := quotation.PricingMode(*body.PricingMode)
		mode = &value
	}
	item, err := s.Quotations.UpdateItem(r.Context(), actor, side, id, quotation.UpdateItemInput{
		Idx: body.Idx, MaterialID: body.MaterialID, UnitID: body.UnitID,
		PricingMode: mode, Price: price, TaxRate: taxRate, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationItemDTO(item))
}

func (s *Server) deleteQuotationItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	if err := s.Quotations.DeleteItem(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) queryQuotationTiers(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side,
) {
	queryListAs(s, w, r, actor, quotationListQuery,
		func(ctx context.Context, actor *authz.Actor, query quotation.ListQuery) (quotation.TierListResult, error) {
			return s.Quotations.ListTiers(ctx, actor, side, query)
		},
		func(result quotation.TierListResult) any { return quotationTierListDTO(result) })
}

func (s *Server) getQuotationTier(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	item, err := s.Quotations.GetTier(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationTierDTO(item))
}

func (s *Server) createQuotationTier(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side) {
	var body gen.QuotationTierCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	minQty, err := decimalInput(body.MinQty, quotationTierLabel(side), "minQty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	price, err := decimalInput(body.Price, quotationTierLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Quotations.CreateTier(r.Context(), actor, side, quotation.CreateTierInput{
		ItemID: body.ItemId, MinQty: minQty, Price: price,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, quotationTierDTO(item))
}

func (s *Server) updateQuotationTier(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	var body gen.QuotationTierUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	minQty, err := optionalDecimalInput(body.MinQty, quotationTierLabel(side), "minQty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	price, err := optionalDecimalInput(body.Price, quotationTierLabel(side), "price")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Quotations.UpdateTier(r.Context(), actor, side, id, quotation.UpdateTierInput{
		MinQty: minQty, Price: price,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, quotationTierDTO(item))
}

func (s *Server) deleteQuotationTier(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side quotation.Side, id uuid.UUID) {
	if err := s.Quotations.DeleteTier(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func quotationLabel(side quotation.Side) string {
	if side == quotation.SideSales {
		return "销售报价单"
	}
	return "采购报价单"
}

func quotationItemLabel(side quotation.Side) string {
	if side == quotation.SideSales {
		return "销售报价条目"
	}
	return "采购报价条目"
}

func quotationTierLabel(side quotation.Side) string {
	if side == quotation.SideSales {
		return "销售报价价格档"
	}
	return "采购报价价格档"
}

func quotationDTO(item quotation.Quotation) map[string]any {
	return map[string]any{
		"id": item.ID, "quotationNo": item.QuotationNo,
		"quotationDate": item.QuotationDate.Format("2006-01-02"),
		"validUntil":    item.ValidUntil.Format("2006-01-02"),
		"partyType":     item.PartyType, "partyId": item.PartyID,
		"terms": item.Terms, "remarks": item.Remarks, "status": item.Status,
		"auditedAt": item.AuditedAt, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"companyId": item.CompanyID, "currencyId": item.CurrencyID,
		"createdById": item.CreatedByID, "auditedById": item.AuditedByID,
		"company": item.Company, "currency": map[string]any{
			"id": item.Currency.ID, "name": item.Currency.Name, "isoCode": item.Currency.Code,
		},
		"createdBy": item.CreatedBy, "auditedBy": item.AuditedBy,
	}
}

func quotationListDTO(result quotation.QuotationListResult) map[string]any {
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = quotationDTO(item)
	}
	return map[string]any{"count": result.Count, "results": items}
}

func quotationItemDTO(item quotation.Item) map[string]any {
	var price *string
	if item.Price != nil {
		value := item.Price.String()
		price = &value
	}
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "pricingMode": item.PricingMode,
		"price": price, "taxRate": item.TaxRate.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "customerPartNo": item.CustomerPartNo,
		"unitName": item.UnitName, "remarks": item.Remarks,
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"quotationId": item.QuotationID, "companyId": item.CompanyID,
		"materialId": item.MaterialID, "unitId": item.UnitID, "tierCount": item.TierCount,
		"quotationDate":   item.QuotationDate.Format("2006-01-02"),
		"validUntil":      item.ValidUntil.Format("2006-01-02"),
		"quotationStatus": item.QuotationStatus, "partyType": item.PartyType,
		"partyId": item.PartyID, "currencyCode": item.CurrencyCode,
		"quotation": item.Quotation, "company": item.Company,
		"material": item.Material, "unit": item.Unit,
	}
}

func quotationItemListDTO(result quotation.ItemListResult) map[string]any {
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = quotationItemDTO(item)
	}
	return map[string]any{"count": result.Count, "results": items}
}

func quotationTierDTO(item quotation.Tier) map[string]any {
	return map[string]any{
		"id": item.ID, "minQty": item.MinQty.String(), "price": item.Price.String(),
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"itemId": item.ItemID, "companyId": item.CompanyID, "company": item.Company,
	}
}

func quotationTierListDTO(result quotation.TierListResult) map[string]any {
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = quotationTierDTO(item)
	}
	return map[string]any{"count": result.Count, "results": items}
}
