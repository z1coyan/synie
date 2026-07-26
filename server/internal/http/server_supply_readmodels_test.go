package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/scm/orderflow"
)

func TestSupplyReadModelHandlersAuthorizeBeforeDecodeOrService(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	flowID := "sales_delivery:" + uuid.NewString()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	withFlowID := func(handler func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, flowID) }
	}
	cases := []struct {
		name, method string
		handler      http.HandlerFunc
	}{
		{"company query", http.MethodPost, server.QuerySalesCompanyAccountDefaults},
		{"company get", http.MethodGet, withID(server.GetSalesCompanyAccountDefault)},
		{"company get by company", http.MethodGet, withID(server.GetSalesCompanyAccountDefaultsByCompany)},
		{"company create", http.MethodPost, server.CreateSalesCompanyAccountDefault},
		{"company update", http.MethodPatch, withID(server.UpdateSalesCompanyAccountDefault)},
		{"order flow query", http.MethodPost, server.QueryScmOrderFlowItems},
		{"order flow get", http.MethodGet, withFlowID(server.GetScmOrderFlowItem)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, inventoryRequest(tc.method, "{", nil))
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSupplyReadModelBodyHandlersDecodeOnlyAfterPermission(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	for _, tc := range []struct {
		name, method, permission string
		handler                  http.HandlerFunc
	}{
		{"company query", http.MethodPost, "sales.setting:read", server.QuerySalesCompanyAccountDefaults},
		{"company create", http.MethodPost, "sales.setting:update", server.CreateSalesCompanyAccountDefault},
		{"company update", http.MethodPatch, "sales.setting:update", withID(server.UpdateSalesCompanyAccountDefault)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, inventoryRequest(tc.method, "{", map[string]struct{}{tc.permission: {}}))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}

	for _, permission := range []string{
		"purchase.receipt:read",
		"purchase.outsourced_issue:read",
		"purchase.outsourced_receipt:read",
		"sales.delivery:read",
	} {
		t.Run("order flow query "+permission, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.QueryScmOrderFlowItems(response,
				inventoryRequest(http.MethodPost, "{", map[string]struct{}{permission: {}}))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}

	response := httptest.NewRecorder()
	server.QueryScmOrderFlowItems(response, inventoryRequest(
		http.MethodPost, "{", map[string]struct{}{"scm.order_flow:read": {}},
	))
	if response.Code != http.StatusForbidden {
		t.Fatalf("synthetic permission status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSupplyReadModelNullablePatchAnchorsAndDTOs(t *testing.T) {
	debitID := uuid.New()
	input, err := companyAccountDefaultUpdateInput(companyAccountDefaultUpdateBody{
		DeliveryDebitAccountID: json.RawMessage(`"` + debitID.String() + `"`),
		ReceiptCreditAccountID: json.RawMessage(`null`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !input.DeliveryDebitAccountID.Set || input.DeliveryDebitAccountID.Value == nil ||
		*input.DeliveryDebitAccountID.Value != debitID ||
		!input.ReceiptCreditAccountID.Set || input.ReceiptCreditAccountID.Value != nil ||
		input.DeliveryCreditAccountID.Set {
		t.Fatalf("patch input = %#v", input)
	}

	orderID := uuid.New()
	filter := map[string]json.RawMessage{
		"orderId": json.RawMessage(`{"kind":"fk","op":"in","values":["` + orderID.String() + `"]}`),
		"status":  json.RawMessage(`{"kind":"enum","values":["AUDITED"]}`),
	}
	gotOrderID, gotOrderItemID, err := takeOrderFlowAnchors(filter)
	if err != nil || gotOrderID == nil || *gotOrderID != orderID || gotOrderItemID != nil {
		t.Fatalf("anchors = %v %v %v", gotOrderID, gotOrderItemID, err)
	}
	if _, exists := filter["orderId"]; exists {
		t.Fatal("orderId must be removed before generic filter building")
	}
	if _, exists := filter["status"]; !exists {
		t.Fatal("generic status filter must remain")
	}

	date := time.Date(2026, 7, 26, 17, 30, 0, 0, time.UTC)
	wire := orderFlowItemDTO(orderflow.Item{
		ID: "sales_delivery:" + uuid.NewString(), FlowType: "sales_delivery",
		VoucherNo: "SD-1", VoucherDate: date, Status: "audited",
		CompanyID: uuid.New(), OrderID: orderID, OrderItemID: uuid.New(),
		MaterialCode: "M1", MaterialName: "物料", UnitName: "件",
		Qty: decimal.RequireFromString("2.5000"),
	})
	raw, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["voucherDate"] != "2026-07-26" || decoded["qty"] != "2.5" ||
		decoded["flowType"] != "SALES_DELIVERY" || decoded["status"] != "AUDITED" {
		t.Fatalf("order flow wire = %s", raw)
	}

	defaults := companyAccountDefaultDTO(companyaccountdefault.CompanyAccountDefault{
		ID: uuid.New(), CompanyID: uuid.New(), DeliveryDebitAccountID: &debitID,
		InsertedAt: date, UpdatedAt: date,
	})
	if defaults.DeliveryDebitAccountId == nil || *defaults.DeliveryDebitAccountId != debitID ||
		defaults.InsertedAt != date || defaults.UpdatedAt != date {
		t.Fatalf("company defaults DTO = %#v", defaults)
	}
}
