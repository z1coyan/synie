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

func TestMasterDataHandlersAuthorizeBeforeDecodingJSON(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	cases := []struct {
		name       string
		method     string
		permission string
		handler    http.HandlerFunc
	}{
		{"query customer", http.MethodPost, "sales.customer:read", server.QuerySalesCustomers},
		{"create customer", http.MethodPost, "sales.customer:create", server.CreateSalesCustomer},
		{"update customer", http.MethodPatch, "sales.customer:update", func(w http.ResponseWriter, r *http.Request) {
			server.UpdateSalesCustomer(w, r, id)
		}},
		{"query supplier", http.MethodPost, "purchase.supplier:read", server.QueryPurchaseSuppliers},
		{"create supplier", http.MethodPost, "purchase.supplier:create", server.CreatePurchaseSupplier},
		{"update supplier", http.MethodPatch, "purchase.supplier:update", func(w http.ResponseWriter, r *http.Request) {
			server.UpdatePurchaseSupplier(w, r, id)
		}},
		{"query employee", http.MethodPost, "hr.employee:read", server.QueryHrEmployees},
		{"create employee", http.MethodPost, "hr.employee:create", server.CreateHrEmployee},
		{"update employee", http.MethodPatch, "hr.employee:update", func(w http.ResponseWriter, r *http.Request) {
			server.UpdateHrEmployee(w, r, id)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, "/", strings.NewReader("{"))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
				UserID: uuid.New(),
			}))
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status = %d, body=%s", response.Code, response.Body.String())
			}

			request = httptest.NewRequest(tc.method, "/", strings.NewReader("{"))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
				UserID: uuid.New(), Permissions: map[string]struct{}{tc.permission: {}},
			}))
			response = httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}
