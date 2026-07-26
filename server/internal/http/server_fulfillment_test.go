package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
)

func TestFulfillmentHandlersAuthorizeBeforeDecodeOrService(t *testing.T) {
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
	addStandard := func(label, prefix string, heads []http.HandlerFunc, items []http.HandlerFunc) {
		actions := []string{"read", "read", "create", "update", "delete", "audit", "void"}
		methods := []string{http.MethodPost, http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodPost, http.MethodPost}
		for i, handler := range heads {
			cases = append(cases, testCase{label + " head " + actions[i], methods[i], prefix + ":" + actions[i], handler})
		}
		itemActions := []string{"read", "read", "create", "update", "delete"}
		itemMethods := []string{http.MethodPost, http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete}
		for i, handler := range items {
			cases = append(cases, testCase{label + " item " + itemActions[i], itemMethods[i], prefix + ":" + itemActions[i], handler})
		}
	}
	addStandard("sales delivery", "sales.delivery",
		[]http.HandlerFunc{server.QuerySalesDeliveries, withID(server.GetSalesDelivery), server.CreateSalesDelivery, withID(server.UpdateSalesDelivery), withID(server.DeleteSalesDelivery), withID(server.AuditSalesDelivery), withID(server.VoidSalesDelivery)},
		[]http.HandlerFunc{server.QuerySalesDeliveryItems, withID(server.GetSalesDeliveryItem), server.CreateSalesDeliveryItem, withID(server.UpdateSalesDeliveryItem), withID(server.DeleteSalesDeliveryItem)})
	addStandard("purchase receipt", "purchase.receipt",
		[]http.HandlerFunc{server.QueryPurchaseReceipts, withID(server.GetPurchaseReceipt), server.CreatePurchaseReceipt, withID(server.UpdatePurchaseReceipt), withID(server.DeletePurchaseReceipt), withID(server.AuditPurchaseReceipt), withID(server.VoidPurchaseReceipt)},
		[]http.HandlerFunc{server.QueryPurchaseReceiptItems, withID(server.GetPurchaseReceiptItem), server.CreatePurchaseReceiptItem, withID(server.UpdatePurchaseReceiptItem), withID(server.DeletePurchaseReceiptItem)})
	addStandard("outsourced issue", "purchase.outsourced_issue",
		[]http.HandlerFunc{server.QueryPurchaseOutsourcedIssues, withID(server.GetPurchaseOutsourcedIssue), server.CreatePurchaseOutsourcedIssue, withID(server.UpdatePurchaseOutsourcedIssue), withID(server.DeletePurchaseOutsourcedIssue), withID(server.AuditPurchaseOutsourcedIssue), withID(server.VoidPurchaseOutsourcedIssue)},
		[]http.HandlerFunc{server.QueryPurchaseOutsourcedIssueItems, withID(server.GetPurchaseOutsourcedIssueItem), server.CreatePurchaseOutsourcedIssueItem, withID(server.UpdatePurchaseOutsourcedIssueItem), withID(server.DeletePurchaseOutsourcedIssueItem)})
	addStandard("outsourced receipt", "purchase.outsourced_receipt",
		[]http.HandlerFunc{server.QueryPurchaseOutsourcedReceipts, withID(server.GetPurchaseOutsourcedReceipt), server.CreatePurchaseOutsourcedReceipt, withID(server.UpdatePurchaseOutsourcedReceipt), withID(server.DeletePurchaseOutsourcedReceipt), withID(server.AuditPurchaseOutsourcedReceipt), withID(server.VoidPurchaseOutsourcedReceipt)},
		[]http.HandlerFunc{server.QueryPurchaseOutsourcedReceiptItems, withID(server.GetPurchaseOutsourcedReceiptItem), server.CreatePurchaseOutsourcedReceiptItem, withID(server.UpdatePurchaseOutsourcedReceiptItem), withID(server.DeletePurchaseOutsourcedReceiptItem)})
	for _, child := range []struct {
		name   string
		query  http.HandlerFunc
		get    http.HandlerFunc
		create http.HandlerFunc
		update http.HandlerFunc
		delete http.HandlerFunc
	}{
		{"material", server.QueryPurchaseOutsourcedReceiptItemMaterials, withID(server.GetPurchaseOutsourcedReceiptItemMaterial), server.CreatePurchaseOutsourcedReceiptItemMaterial, withID(server.UpdatePurchaseOutsourcedReceiptItemMaterial), withID(server.DeletePurchaseOutsourcedReceiptItemMaterial)},
		{"byproduct", server.QueryPurchaseOutsourcedReceiptItemByproducts, withID(server.GetPurchaseOutsourcedReceiptItemByproduct), server.CreatePurchaseOutsourcedReceiptItemByproduct, withID(server.UpdatePurchaseOutsourcedReceiptItemByproduct), withID(server.DeletePurchaseOutsourcedReceiptItemByproduct)},
	} {
		cases = append(cases,
			testCase{"outsourced receipt " + child.name + " query", http.MethodPost, "purchase.outsourced_receipt:read", child.query},
			testCase{"outsourced receipt " + child.name + " get", http.MethodGet, "purchase.outsourced_receipt:read", child.get},
			testCase{"outsourced receipt " + child.name + " create", http.MethodPost, "purchase.outsourced_receipt:create", child.create},
			testCase{"outsourced receipt " + child.name + " update", http.MethodPatch, "purchase.outsourced_receipt:update", child.update},
			testCase{"outsourced receipt " + child.name + " delete", http.MethodDelete, "purchase.outsourced_receipt:delete", child.delete},
		)
	}
	cases = append(cases, testCase{
		"company account defaults", http.MethodGet, "sales.setting:read",
		withID(server.GetSalesCompanyAccountDefaultsByCompany),
	})

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

func TestFulfillmentBodyHandlersAuthorizeBeforeJSONValidation(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	withID := func(handler func(http.ResponseWriter, *http.Request, uuid.UUID)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { handler(w, r, id) }
	}
	cases := []struct {
		name, method, permission string
		handler                  http.HandlerFunc
	}{
		{"sales query", http.MethodPost, "sales.delivery:read", server.QuerySalesDeliveries},
		{"sales create", http.MethodPost, "sales.delivery:create", server.CreateSalesDelivery},
		{"sales update", http.MethodPatch, "sales.delivery:update", withID(server.UpdateSalesDelivery)},
		{"sales item create", http.MethodPost, "sales.delivery:create", server.CreateSalesDeliveryItem},
		{"purchase query", http.MethodPost, "purchase.receipt:read", server.QueryPurchaseReceipts},
		{"purchase create", http.MethodPost, "purchase.receipt:create", server.CreatePurchaseReceipt},
		{"purchase update", http.MethodPatch, "purchase.receipt:update", withID(server.UpdatePurchaseReceipt)},
		{"issue query", http.MethodPost, "purchase.outsourced_issue:read", server.QueryPurchaseOutsourcedIssues},
		{"issue create", http.MethodPost, "purchase.outsourced_issue:create", server.CreatePurchaseOutsourcedIssue},
		{"issue update", http.MethodPatch, "purchase.outsourced_issue:update", withID(server.UpdatePurchaseOutsourcedIssue)},
		{"receipt query", http.MethodPost, "purchase.outsourced_receipt:read", server.QueryPurchaseOutsourcedReceipts},
		{"receipt create", http.MethodPost, "purchase.outsourced_receipt:create", server.CreatePurchaseOutsourcedReceipt},
		{"receipt update", http.MethodPatch, "purchase.outsourced_receipt:update", withID(server.UpdatePurchaseOutsourcedReceipt)},
		{"material create", http.MethodPost, "purchase.outsourced_receipt:create", server.CreatePurchaseOutsourcedReceiptItemMaterial},
		{"byproduct update", http.MethodPatch, "purchase.outsourced_receipt:update", withID(server.UpdatePurchaseOutsourcedReceiptItemByproduct)},
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

func TestFulfillmentDTOUsesDateOnlyAndDecimalStrings(t *testing.T) {
	date := time.Date(2026, 7, 26, 15, 30, 0, 0, time.UTC)
	standardHead := standardHeadDTO(standard.Head{DocumentDate: date}, standard.SideSales)
	if standardHead["deliveryDate"] != "2026-07-26" {
		t.Fatalf("standard head date=%#v", standardHead["deliveryDate"])
	}
	standardItem := standardItemDTO(standard.Item{
		HeadDate: date, Qty: decimal.RequireFromString("2.5000"),
		BaseQty: decimal.RequireFromString("1.2500"),
	}, standard.SideSales)
	if standardItem["deliveryDate"] != "2026-07-26" || standardItem["qty"] != "2.5" ||
		standardItem["baseQty"] != "1.25" {
		t.Fatalf("standard item wire=%#v", standardItem)
	}
	issueItem := outsourcedIssueItemDTO(outsourced.IssueItem{
		IssueDate: date, Qty: decimal.RequireFromString("3.5000"),
		BaseQty: decimal.RequireFromString("7.0000"),
	})
	if issueItem["issueDate"] != "2026-07-26" || issueItem["qty"] != "3.5" ||
		issueItem["baseQty"] != "7" {
		t.Fatalf("outsourced issue item wire=%#v", issueItem)
	}
}
