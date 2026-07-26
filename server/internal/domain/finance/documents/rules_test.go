package documents

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPublicReadsArePermissionFirst(t *testing.T) {
	service := NewService(nil, Dependencies{})
	actor := &authz.Actor{}
	id := uuid.New()
	tests := []struct {
		name string
		call func() error
	}{
		{"invoice", func() error { _, err := service.GetVatInvoice(context.Background(), actor, id); return err }},
		{"expense report", func() error { _, err := service.GetExpenseReport(context.Background(), actor, id); return err }},
		{"expense item", func() error { _, err := service.GetExpenseReportItem(context.Background(), actor, id); return err }},
		{"bill", func() error { _, err := service.GetBill(context.Background(), actor, id); return err }},
		{"bill transaction", func() error { _, err := service.GetBillTransaction(context.Background(), actor, id); return err }},
		{"bill holding", func() error { _, err := service.GetBillHolding(context.Background(), actor, id); return err }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.call()
			if errorCode(err) != apierror.CodeForbidden {
				t.Fatalf("want permission error before nil pool access, got %v", err)
			}
		})
	}
}

func TestNormalizeInvoiceEnforcesDirectionPartyAndReconciliationSlots(t *testing.T) {
	companyID, employeeID := uuid.New(), uuid.New()
	_, err := normalizeVatInvoiceInput(VatInvoiceInput{
		CompanyID: companyID, Direction: DirectionOutbound,
		PartyType: PartyEmployee, PartyID: employeeID,
		InvoiceKind: InvoiceNormal, Items: "[]",
	})
	if errorCode(err) != apierror.CodeValidation {
		t.Fatalf("employee outbound invoice must be rejected: %v", err)
	}
	_, err = normalizeVatInvoiceInput(VatInvoiceInput{
		CompanyID: companyID, Direction: DirectionInbound,
		PartyType: PartySupplier, PartyID: uuid.New(),
		InvoiceKind: InvoiceNormal, Items: "[]",
	})
	if errorCode(err) != apierror.CodeValidation {
		t.Fatalf("non-employee inbound invoice without purchase reconciliation must be rejected: %v", err)
	}
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func TestOCRMappingKeepsPrefillSparseAndBillSegmentExact(t *testing.T) {
	invoice := mapInvoiceOCR(map[string]any{
		"data": map[string]any{
			"invoiceNumber": " 001 ", "invoiceDate": "2026年7月2日",
			"invoiceType": "数电专用发票", "totalAmount": "¥1,234.50",
		},
	})
	if invoice["invoiceNo"] != "001" || invoice["invoiceDate"] != "2026-07-02" ||
		invoice["invoiceKind"] != InvoiceDigitalSpecial || invoice["grossTotal"] != "1234.50" {
		t.Fatalf("unexpected invoice prefill: %#v", invoice)
	}
	if _, exists := invoice["sellerName"]; exists {
		t.Fatalf("unrecognized values must be omitted: %#v", invoice)
	}
	bill := mapAcceptanceOCR(map[string]any{
		"draftNumber": "B-1", "subDraftNumber": "101-350",
	})
	if bill["sub_start"] != int64(101) || bill["sub_end"] != int64(350) ||
		bill["amount"] != "2.50" || bill["bill_kind"] != BillBankAcceptance {
		t.Fatalf("unexpected bill prefill: %#v", bill)
	}
}

func TestAliyunOCRCallSignsAndDecodesData(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("x-acs-action") != "RecognizeInvoice" ||
			request.Header.Get("x-acs-content-sha256") == "" ||
			!strings.Contains(request.Header.Get("authorization"),
				"ACS3-HMAC-SHA256 Credential=test-id") {
			t.Fatalf("missing ACS3 signed headers: %#v", request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"Data":"{\"invoiceNumber\":\"001\"}"}`)),
			Header:     make(http.Header),
		}, nil
	})}
	recognizer := &aliyunOCR{
		client: client,
		now: func() time.Time {
			return time.Date(2026, 7, 26, 1, 2, 3, 0, time.UTC)
		},
		nonce: func() string { return "fixed-nonce" },
	}
	result, err := recognizer.call(
		context.Background(), "RecognizeInvoice", []byte("image"), "test-id", "test-secret",
	)
	if err != nil || result["invoiceNumber"] != "001" {
		t.Fatalf("signed OCR response decode failed: %#v %v", result, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
