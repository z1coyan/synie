package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/z1coyan/synie/server/internal/http/gen"
)

func TestGLEntryHandlersAuthorizeBeforeInputValidation(t *testing.T) {
	server := &Server{}
	cases := []struct {
		name       string
		request    func(withPermission bool) (*http.Request, *httptest.ResponseRecorder)
		invoke     func(http.ResponseWriter, *http.Request)
		wantStatus int
	}{
		{
			name: "query before JSON",
			request: func(withPermission bool) (*http.Request, *httptest.ResponseRecorder) {
				return glEntryRequest(http.MethodPost, "{", withPermission), httptest.NewRecorder()
			},
			invoke:     server.QueryAccGlEntries,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "get before UUID",
			request: func(withPermission bool) (*http.Request, *httptest.ResponseRecorder) {
				return glEntryRequest(http.MethodGet, "", withPermission), httptest.NewRecorder()
			},
			invoke: func(w http.ResponseWriter, r *http.Request) {
				server.GetAccGlEntry(w, r, "not-a-uuid")
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "report before query params",
			request: func(withPermission bool) (*http.Request, *httptest.ResponseRecorder) {
				return glEntryRequest(http.MethodGet, "", withPermission), httptest.NewRecorder()
			},
			invoke: func(w http.ResponseWriter, r *http.Request) {
				companyID, asOf := "not-a-uuid", "2026-99-99"
				server.GetAccARAPReport(w, r, gen.GetAccARAPReportParams{
					CompanyId: &companyID,
					AsOf:      &asOf,
				})
			},
			wantStatus: http.StatusBadRequest,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request, response := tc.request(false)
			tc.invoke(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status = %d, body=%s", response.Code, response.Body.String())
			}

			request, response = tc.request(true)
			tc.invoke(response, request)
			if response.Code != tc.wantStatus {
				t.Fatalf("with permission invalid input status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestParseARAPReportParams(t *testing.T) {
	companyID, asOf := "2f044514-b724-4ced-8e26-8db0f2b33a16", "2026-07-26"
	parsedCompanyID, parsedAsOf, fields := parseARAPReportParams(gen.GetAccARAPReportParams{
		CompanyId: &companyID,
		AsOf:      &asOf,
	})
	if len(fields) != 0 {
		t.Fatalf("fields = %#v", fields)
	}
	if parsedCompanyID.String() != companyID || parsedAsOf.Format("2006-01-02") != asOf {
		t.Fatalf("parsed values = %s, %s", parsedCompanyID, parsedAsOf)
	}

	_, _, fields = parseARAPReportParams(gen.GetAccARAPReportParams{})
	if len(fields["companyId"]) != 1 || len(fields["asOf"]) != 1 {
		t.Fatalf("missing fields = %#v", fields)
	}
}

func glEntryRequest(method, body string, withPermission bool) *http.Request {
	var permissions map[string]struct{}
	if withPermission {
		permissions = map[string]struct{}{"acc.gl_entry:read": {}}
	}
	return inventoryRequest(method, body, permissions)
}
