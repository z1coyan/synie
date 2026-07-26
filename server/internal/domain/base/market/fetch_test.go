package market

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestPublicMarketClientParsesSinaLast(t *testing.T) {
	body := `var hq_str_nf_CU0="铜连续,010000,103100.000,103990.000,103000.000,0.000,103840.000,103880.000,103880.000,0.000,103720.000,11,1,183964.000,31080,沪,铜,2026-07-18,1";`
	client := &PublicMarketClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}}
	quote, err := client.FetchLast(context.Background(), "CU0")
	if err != nil {
		t.Fatal(err)
	}
	if !quote.Price.Equal(decimal.RequireFromString("103880.000")) ||
		quote.AsOfDate == nil || *quote.AsOfDate != "2026-07-18" {
		t.Fatalf("quote = %#v", quote)
	}
}

func TestPublicMarketClientSelectsSHFEMainAndHandles404(t *testing.T) {
	payload := `{"o_curinstrument":[
		{"PRODUCTGROUPID":"cu","DELIVERYMONTH":"2608","SETTLEMENTPRICE":103810,"OPENINTEREST":127472},
		{"PRODUCTGROUPID":"cu","DELIVERYMONTH":"2609","SETTLEMENTPRICE":103720,"OPENINTEREST":180125}
	]}`
	client := &PublicMarketClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(payload)), Header: make(http.Header)}, nil
	})}}
	quote, err := client.FetchSettlement(context.Background(), "cu", time.Date(2026, 7, 17, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if quote.DeliveryMonth != "2609" || quote.OpenInterest != 180125 ||
		!quote.Price.Equal(decimal.RequireFromString("103720")) {
		t.Fatalf("quote = %#v", quote)
	}

	client.HTTPClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})
	if _, err = client.FetchSettlement(context.Background(), "cu", time.Now()); err != ErrNotAvailable {
		t.Fatalf("404 err = %#v", err)
	}
}

func TestMarketSessionBoundaries(t *testing.T) {
	if pastSettlementWindow(time.Date(2026, 7, 17, 7, 29, 0, 0, time.UTC)) {
		t.Fatal("15:29 Shanghai must be before settlement window")
	}
	if !pastSettlementWindow(time.Date(2026, 7, 17, 7, 30, 0, 0, time.UTC)) {
		t.Fatal("15:30 Shanghai must enter settlement window")
	}
}
