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

func TestMarketHandlersRejectMissingRequiredTimestamps(t *testing.T) {
	server := &Server{}
	tests := []struct {
		name       string
		permission string
		body       string
		handler    http.HandlerFunc
	}{
		{
			name:       "price point observedAt",
			permission: "base.market_price:create",
			body:       `{"price":"1","instrumentId":"00000000-0000-0000-0000-000000000001"}`,
			handler:    server.CreateBasMarketPricePoint,
		},
		{
			name:       "series from and to",
			permission: "base.market_price:read",
			body:       `{"instrumentIds":[],"priceKind":"SETTLEMENT"}`,
			handler:    server.GetBasMarketPriceSeries,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
				UserID: uuid.New(), Permissions: map[string]struct{}{test.permission: {}},
			}))
			response := httptest.NewRecorder()

			test.handler(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}
