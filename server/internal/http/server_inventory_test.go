package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestInventoryHandlersAuthorizeBeforeDecodingJSON(t *testing.T) {
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
		{"query material categories", http.MethodPost, "inv.material_category:read", server.QueryInvMaterialCategories},
		{"create material category", http.MethodPost, "inv.material_category:create", server.CreateInvMaterialCategory},
		{"update material category", http.MethodPatch, "inv.material_category:update", withID(server.UpdateInvMaterialCategory)},
		{"query materials", http.MethodPost, "inv.material:read", server.QueryInvMaterials},
		{"create material", http.MethodPost, "inv.material:create", server.CreateInvMaterial},
		{"update material", http.MethodPatch, "inv.material:update", withID(server.UpdateInvMaterial)},
		{"query material units", http.MethodPost, "inv.material:read", server.QueryInvMaterialUnits},
		{"create material unit", http.MethodPost, "inv.material:create", server.CreateInvMaterialUnit},
		{"update material unit", http.MethodPatch, "inv.material:update", withID(server.UpdateInvMaterialUnit)},
		{"query warehouses", http.MethodPost, "inv.warehouse:read", server.QueryInvWarehouses},
		{"query outsourced warehouses", http.MethodPost, "inv.warehouse:read", server.QueryInvOutsourcedWarehouses},
		{"create warehouse", http.MethodPost, "inv.warehouse:create", server.CreateInvWarehouse},
		{"update warehouse", http.MethodPatch, "inv.warehouse:update", withID(server.UpdateInvWarehouse)},
		{"query stock entries", http.MethodPost, "inv.stock_entry:read", server.QueryInvStockEntries},
		{"query stock balance", http.MethodPost, "inv.stock_entry:read", server.QueryInvStockBalance},
		{"query stock docs", http.MethodPost, "inv.stock_doc:read", server.QueryInvStockDocs},
		{"create stock doc", http.MethodPost, "inv.stock_doc:create", server.CreateInvStockDoc},
		{"update stock doc", http.MethodPatch, "inv.stock_doc:update", withID(server.UpdateInvStockDoc)},
		{"query stock doc items", http.MethodPost, "inv.stock_doc:read", server.QueryInvStockDocItems},
		{"create stock doc item", http.MethodPost, "inv.stock_doc:create", server.CreateInvStockDocItem},
		{"update stock doc item", http.MethodPatch, "inv.stock_doc:update", withID(server.UpdateInvStockDocItem)},
		{"query stock transfers", http.MethodPost, "inv.stock_transfer:read", server.QueryInvStockTransfers},
		{"create stock transfer", http.MethodPost, "inv.stock_transfer:create", server.CreateInvStockTransfer},
		{"update stock transfer", http.MethodPatch, "inv.stock_transfer:update", withID(server.UpdateInvStockTransfer)},
		{"receive stock transfer", http.MethodPost, "inv.stock_transfer:receive", withID(server.ReceiveInvStockTransfer)},
		{"query stock transfer items", http.MethodPost, "inv.stock_transfer:read", server.QueryInvStockTransferItems},
		{"create stock transfer item", http.MethodPost, "inv.stock_transfer:create", server.CreateInvStockTransferItem},
		{"update stock transfer item", http.MethodPatch, "inv.stock_transfer:update", withID(server.UpdateInvStockTransferItem)},
		{"query stock counts", http.MethodPost, "inv.stock_count:read", server.QueryInvStockCounts},
		{"create stock count", http.MethodPost, "inv.stock_count:create", server.CreateInvStockCount},
		{"update stock count", http.MethodPatch, "inv.stock_count:update", withID(server.UpdateInvStockCount)},
		{"query stock count items", http.MethodPost, "inv.stock_count:read", server.QueryInvStockCountItems},
		{"create stock count item", http.MethodPost, "inv.stock_count:create", server.CreateInvStockCountItem},
		{"update stock count item", http.MethodPatch, "inv.stock_count:update", withID(server.UpdateInvStockCountItem)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := inventoryRequest(tc.method, "{", nil)
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status = %d, body=%s", response.Code, response.Body.String())
			}

			permissions := map[string]struct{}{tc.permission: {}}
			request = inventoryRequest(tc.method, "{", permissions)
			response = httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func inventoryRequest(method, body string, permissions map[string]struct{}) *http.Request {
	request := httptest.NewRequest(method, "/", strings.NewReader(body))
	actor := &authz.Actor{UserID: uuid.New(), Permissions: permissions}
	return request.WithContext(context.WithValue(request.Context(), actorContextKey{}, actor))
}
