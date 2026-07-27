package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
)

func TestQuotationHandlersAuthorizeBeforeInputOrLookup(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		name       string
		method     string
		permission string
		handler    http.HandlerFunc
	}{
		{"query sales quotations", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotations},
		{"get sales quotation", http.MethodGet, "sales.quotation:read", withID(server.GetSalesQuotation)},
		{"create sales quotation", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotation},
		{"update sales quotation", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotation)},
		{"delete sales quotation", http.MethodDelete, "sales.quotation:delete", withID(server.DeleteSalesQuotation)},
		{"audit sales quotation", http.MethodPost, "sales.quotation:audit", withID(server.AuditSalesQuotation)},
		{"void sales quotation", http.MethodPost, "sales.quotation:void", withID(server.VoidSalesQuotation)},
		{"query sales items", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotationItems},
		{"get sales item", http.MethodGet, "sales.quotation:read", withID(server.GetSalesQuotationItem)},
		{"create sales item", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotationItem},
		{"update sales item", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotationItem)},
		{"delete sales item", http.MethodDelete, "sales.quotation:delete", withID(server.DeleteSalesQuotationItem)},
		{"query sales tiers", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotationTiers},
		{"get sales tier", http.MethodGet, "sales.quotation:read", withID(server.GetSalesQuotationTier)},
		{"create sales tier", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotationTier},
		{"update sales tier", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotationTier)},
		{"delete sales tier", http.MethodDelete, "sales.quotation:delete", withID(server.DeleteSalesQuotationTier)},
		{"query purchase quotations", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotations},
		{"get purchase quotation", http.MethodGet, "purchase.quotation:read", withID(server.GetPurchaseQuotation)},
		{"create purchase quotation", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotation},
		{"update purchase quotation", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotation)},
		{"delete purchase quotation", http.MethodDelete, "purchase.quotation:delete", withID(server.DeletePurchaseQuotation)},
		{"audit purchase quotation", http.MethodPost, "purchase.quotation:audit", withID(server.AuditPurchaseQuotation)},
		{"void purchase quotation", http.MethodPost, "purchase.quotation:void", withID(server.VoidPurchaseQuotation)},
		{"query purchase items", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotationItems},
		{"get purchase item", http.MethodGet, "purchase.quotation:read", withID(server.GetPurchaseQuotationItem)},
		{"create purchase item", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotationItem},
		{"update purchase item", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotationItem)},
		{"delete purchase item", http.MethodDelete, "purchase.quotation:delete", withID(server.DeletePurchaseQuotationItem)},
		{"query purchase tiers", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotationTiers},
		{"get purchase tier", http.MethodGet, "purchase.quotation:read", withID(server.GetPurchaseQuotationTier)},
		{"create purchase tier", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotationTier},
		{"update purchase tier", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotationTier)},
		{"delete purchase tier", http.MethodDelete, "purchase.quotation:delete", withID(server.DeletePurchaseQuotationTier)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := inventoryRequest(tc.method, "{", nil)
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without %s status = %d, body=%s", tc.permission, response.Code, response.Body.String())
			}
		})
	}
}

func TestQuotationBodyHandlersAuthorizeBeforeJSONValidation(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		name       string
		method     string
		permission string
		handler    http.HandlerFunc
	}{
		{"query sales quotations", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotations},
		{"create sales quotation", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotation},
		{"update sales quotation", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotation)},
		{"query sales items", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotationItems},
		{"create sales item", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotationItem},
		{"update sales item", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotationItem)},
		{"query sales tiers", http.MethodPost, "sales.quotation:read", server.QuerySalesQuotationTiers},
		{"create sales tier", http.MethodPost, "sales.quotation:create", server.CreateSalesQuotationTier},
		{"update sales tier", http.MethodPatch, "sales.quotation:update", withID(server.UpdateSalesQuotationTier)},
		{"query purchase quotations", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotations},
		{"create purchase quotation", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotation},
		{"update purchase quotation", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotation)},
		{"query purchase items", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotationItems},
		{"create purchase item", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotationItem},
		{"update purchase item", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotationItem)},
		{"query purchase tiers", http.MethodPost, "purchase.quotation:read", server.QueryPurchaseQuotationTiers},
		{"create purchase tier", http.MethodPost, "purchase.quotation:create", server.CreatePurchaseQuotationTier},
		{"update purchase tier", http.MethodPatch, "purchase.quotation:update", withID(server.UpdatePurchaseQuotationTier)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := inventoryRequest(tc.method, "{", map[string]struct{}{tc.permission: {}})
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestOptionalDecimalUpdate(t *testing.T) {
	value, err := optionalDecimalUpdate([]byte(`"12.3400"`), "报价条目", "price")
	if err != nil || !value.Set || value.Value == nil || !value.Value.Equal(decimal.RequireFromString("12.34")) {
		t.Fatalf("valid decimal = %#v, err=%v", value, err)
	}
	value, err = optionalDecimalUpdate([]byte(`null`), "报价条目", "price")
	if err != nil || !value.Set || value.Value != nil {
		t.Fatalf("null decimal = %#v, err=%v", value, err)
	}
	value, err = optionalDecimalUpdate(nil, "报价条目", "price")
	if err != nil || value.Set {
		t.Fatalf("omitted decimal = %#v, err=%v", value, err)
	}
	if _, err := optionalDecimalUpdate([]byte(`12.34`), "报价条目", "price"); err == nil {
		t.Fatal("numeric JSON value must not bypass decimal-string contract")
	}
	if _, err := optionalDecimalUpdate([]byte(`"bad"`), "报价条目", "price"); err == nil {
		t.Fatal("invalid decimal should fail")
	}
}

func TestQuotationDTOUsesDateOnlyAndDecimalStrings(t *testing.T) {
	date := time.Date(2026, 7, 26, 15, 30, 0, 0, time.UTC)
	head := quotationDTO(quotation.Quotation{QuotationDate: date, ValidUntil: date})
	if head["quotationDate"] != "2026-07-26" || head["validUntil"] != "2026-07-26" {
		t.Fatalf("head dates = %#v, %#v", head["quotationDate"], head["validUntil"])
	}

	price := decimal.RequireFromString("123.4500")
	item := quotationItemDTO(quotation.Item{
		Price: &price, TaxRate: decimal.RequireFromString("0.1300"),
		QuotationDate: date, ValidUntil: date,
	})
	if got := *(item["price"].(*string)); got != "123.45" {
		t.Fatalf("item price = %q", got)
	}
	if item["taxRate"] != "0.13" {
		t.Fatalf("item taxRate = %#v", item["taxRate"])
	}
	if item["quotationDate"] != "2026-07-26" || item["validUntil"] != "2026-07-26" {
		t.Fatalf("item dates = %#v, %#v", item["quotationDate"], item["validUntil"])
	}

	tier := quotationTierDTO(quotation.Tier{
		MinQty: decimal.RequireFromString("100.000"), Price: decimal.RequireFromString("9.5000"),
	})
	if tier["minQty"] != "100" || tier["price"] != "9.5" {
		t.Fatalf("tier decimals = %#v, %#v", tier["minQty"], tier["price"])
	}
}
