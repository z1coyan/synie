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

func TestSettingUpdatesAuthorizeBeforeDecodingJSON(t *testing.T) {
	server := &Server{}
	cases := []struct {
		name       string
		permission string
		handler    http.HandlerFunc
	}{
		{name: "sales", permission: "sales.setting:update", handler: server.UpdateSalesSetting},
		{name: "manufacturing", permission: "mfg.setting:update", handler: server.UpdateManufacturingSetting},
		{name: "accounting", permission: "acc.setting:update", handler: server.UpdateAccountingSetting},
		{name: "system", permission: "sys.setting:update", handler: server.UpdateSystemSetting},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader("{"))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
				UserID: uuid.New(),
			}))
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status = %d, body=%s", response.Code, response.Body.String())
			}

			request = httptest.NewRequest(http.MethodPatch, "/", strings.NewReader("{"))
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
