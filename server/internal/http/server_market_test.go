package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestMarketWritesAuthorizeBeforeDecoding(t *testing.T) {
	server := &Server{}
	id := uuid.New()
	cases := []struct {
		name       string
		permission string
		handler    http.HandlerFunc
	}{
		{name: "create instrument", permission: "base.market_instrument:create", handler: server.CreateBasMarketInstrument},
		{name: "update instrument", permission: "base.market_instrument:update", handler: func(w http.ResponseWriter, r *http.Request) {
			server.UpdateBasMarketInstrument(w, r, id)
		}},
		{name: "create point", permission: "base.market_price:create", handler: server.CreateBasMarketPricePoint},
		{name: "refresh", permission: "base.market_price:create", handler: server.RefreshBasMarketPricePoints},
		{name: "series", permission: "base.market_price:read", handler: server.GetBasMarketPriceSeries},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{"))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{UserID: uuid.New()}))
			response := httptest.NewRecorder()
			test.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status=%d body=%s", response.Code, response.Body.String())
			}

			request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{"))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
				UserID: uuid.New(), Permissions: map[string]struct{}{test.permission: {}},
			}))
			response = httptest.NewRecorder()
			test.handler(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestMarketChartAndSeriesJSONUseLowerCamelAndLowercaseKinds(t *testing.T) {
	id, currencyID, unitID := uuid.New(), uuid.New(), uuid.New()
	item := market.ChartInstrument{
		ID: id, InstrumentID: id, Code: "CU", Name: "沪铜",
		CurrencyID: currencyID, UnitID: unitID, DefaultPriceKind: "settlement",
	}
	raw, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, expected := range []string{`"id"`, `"instrumentId"`, `"defaultPriceKind":"settlement"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("chart JSON missing %s: %s", expected, text)
		}
	}
	if strings.Contains(text, `"ID"`) || strings.Contains(text, `"InstrumentID"`) {
		t.Fatalf("chart JSON leaked Go field names: %s", text)
	}

	payload := priceSeriesDTO(market.PriceSeries{
		PriceKind: "settlement", From: time.Unix(0, 0).UTC(), To: time.Unix(60, 0).UTC(),
		Series: []market.InstrumentSeries{{
			ChartInstrument: item,
			Points:          []market.SeriesPoint{{ObservedAt: time.Unix(30, 0).UTC(), Price: decimal.NewFromInt(100)}},
		}},
	})
	raw, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text = string(raw)
	if !strings.Contains(text, `"priceKind":"settlement"`) ||
		!strings.Contains(text, `"defaultPriceKind":"settlement"`) ||
		!strings.Contains(text, `"points":[{"observedAt"`) {
		t.Fatalf("series JSON contract mismatch: %s", text)
	}
}
