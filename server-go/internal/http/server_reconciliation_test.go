package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
)

func TestReconciliationHandlersAuthorizeBeforeDecodeOrService(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	type testCase struct {
		name, method, permission string
		handler                  http.HandlerFunc
	}
	var cases []testCase
	add := func(
		label, prefix string,
		queryHead, createHead http.HandlerFunc,
		getHead, updateHead, deleteHead, confirm, unconfirm, audit, voidHead http.HandlerFunc,
		queryItem, createItem http.HandlerFunc,
		getItem, updateItem, deleteItem http.HandlerFunc,
	) {
		cases = append(cases,
			testCase{label + " query", http.MethodPost, prefix + ":read", queryHead},
			testCase{label + " get", http.MethodGet, prefix + ":read", getHead},
			testCase{label + " create", http.MethodPost, prefix + ":create", createHead},
			testCase{label + " update", http.MethodPatch, prefix + ":update", updateHead},
			testCase{label + " delete", http.MethodDelete, prefix + ":delete", deleteHead},
			testCase{label + " confirm", http.MethodPost, prefix + ":confirm", confirm},
			testCase{label + " unconfirm", http.MethodPost, prefix + ":unconfirm", unconfirm},
			testCase{label + " audit", http.MethodPost, prefix + ":audit", audit},
			testCase{label + " void", http.MethodPost, prefix + ":void", voidHead},
			testCase{label + " item query", http.MethodPost, prefix + ":read", queryItem},
			testCase{label + " item get", http.MethodGet, prefix + ":read", getItem},
			testCase{label + " item create", http.MethodPost, prefix + ":create", createItem},
			testCase{label + " item update", http.MethodPatch, prefix + ":update", updateItem},
			testCase{label + " item delete", http.MethodDelete, prefix + ":delete", deleteItem},
		)
	}
	add(
		"sales reconciliation", "sales.reconciliation",
		server.QuerySalesReconciliations, server.CreateSalesReconciliation,
		withID(server.GetSalesReconciliation), withID(server.UpdateSalesReconciliation),
		withID(server.DeleteSalesReconciliation), withID(server.ConfirmSalesReconciliation),
		withID(server.UnconfirmSalesReconciliation), withID(server.AuditSalesReconciliation),
		withID(server.VoidSalesReconciliation), server.QuerySalesReconciliationItems,
		server.CreateSalesReconciliationItem, withID(server.GetSalesReconciliationItem),
		withID(server.UpdateSalesReconciliationItem), withID(server.DeleteSalesReconciliationItem),
	)
	add(
		"purchase reconciliation", "purchase.reconciliation",
		server.QueryPurchaseReconciliations, server.CreatePurchaseReconciliation,
		withID(server.GetPurchaseReconciliation), withID(server.UpdatePurchaseReconciliation),
		withID(server.DeletePurchaseReconciliation), withID(server.ConfirmPurchaseReconciliation),
		withID(server.UnconfirmPurchaseReconciliation), withID(server.AuditPurchaseReconciliation),
		withID(server.VoidPurchaseReconciliation), server.QueryPurchaseReconciliationItems,
		server.CreatePurchaseReconciliationItem, withID(server.GetPurchaseReconciliationItem),
		withID(server.UpdatePurchaseReconciliationItem), withID(server.DeletePurchaseReconciliationItem),
	)

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

func TestReconciliationBodyHandlersReachJSONOnlyAfterAuthorization(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		handler    http.HandlerFunc
		method     string
		permission string
	}{
		{server.QuerySalesReconciliations, http.MethodPost, "sales.reconciliation:read"},
		{server.CreateSalesReconciliation, http.MethodPost, "sales.reconciliation:create"},
		{withID(server.UpdateSalesReconciliation), http.MethodPatch, "sales.reconciliation:update"},
		{withID(server.AuditSalesReconciliation), http.MethodPost, "sales.reconciliation:audit"},
		{server.CreateSalesReconciliationItem, http.MethodPost, "sales.reconciliation:create"},
		{withID(server.UpdateSalesReconciliationItem), http.MethodPatch, "sales.reconciliation:update"},
		{server.QueryPurchaseReconciliations, http.MethodPost, "purchase.reconciliation:read"},
		{server.CreatePurchaseReconciliation, http.MethodPost, "purchase.reconciliation:create"},
		{withID(server.UpdatePurchaseReconciliation), http.MethodPatch, "purchase.reconciliation:update"},
		{withID(server.AuditPurchaseReconciliation), http.MethodPost, "purchase.reconciliation:audit"},
		{server.CreatePurchaseReconciliationItem, http.MethodPost, "purchase.reconciliation:create"},
		{withID(server.UpdatePurchaseReconciliationItem), http.MethodPatch, "purchase.reconciliation:update"},
	}
	for _, tc := range cases {
		response := httptest.NewRecorder()
		tc.handler(
			response,
			inventoryRequest(tc.method, "{", map[string]struct{}{tc.permission: {}}),
		)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s invalid JSON status=%d body=%s", tc.permission, response.Code, response.Body.String())
		}
	}
}

func TestReconciliationDTOUsesContractWireValues(t *testing.T) {
	date := time.Date(2026, 7, 26, 15, 30, 0, 0, time.UTC)
	head := reconciliationHeadDTO(reconciliation.Head{
		Kind: reconciliation.KindGiftSample, PartyType: "customer",
		Status: reconciliation.StatusClosed, PostingDate: &date,
		GrossTotal:     decimal.RequireFromString("12.3400"),
		BaseGrossTotal: decimal.RequireFromString("15.000"),
	})
	if head["reconciliationType"] != "GIFT_SAMPLE" || head["partyType"] != "CUSTOMER" ||
		head["status"] != "CLOSED" || head["postingDate"] != "2026-07-26" ||
		head["grossTotal"] != "12.34" || head["baseGrossTotal"] != "15" {
		t.Fatalf("head wire=%#v", head)
	}
	item := reconciliationItemDTO(reconciliation.Item{
		Qty: decimal.RequireFromString("2.5000"), BaseQty: decimal.RequireFromString("1.250"),
		Amount: decimal.RequireFromString("5.00"), BaseAmount: decimal.RequireFromString("6.000"),
		ReconciliationStatus: reconciliation.StatusConfirmed,
		SourceNo:             "D-1", SourceDate: date,
	}, reconciliation.SideSales)
	if item["deliveryNo"] != "D-1" || item["deliveryDate"] != "2026-07-26" ||
		item["reconciliationStatus"] != "CONFIRMED" || item["qty"] != "2.5" ||
		item["baseQty"] != "1.25" || item["amount"] != "5" || item["baseAmount"] != "6" {
		t.Fatalf("item wire=%#v", item)
	}
}
