package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
)

func TestGLJournalHandlersAuthorizeBeforeInput(t *testing.T) {
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
		{"query journals", http.MethodPost, "acc.gl_journal:read", server.QueryAccGlJournals},
		{"get journal", http.MethodGet, "acc.gl_journal:read", withID(server.GetAccGlJournal)},
		{"create journal", http.MethodPost, "acc.gl_journal:create", server.CreateAccGlJournal},
		{"update journal", http.MethodPatch, "acc.gl_journal:update", withID(server.UpdateAccGlJournal)},
		{"delete journal", http.MethodDelete, "acc.gl_journal:delete", withID(server.DeleteAccGlJournal)},
		{"audit journal", http.MethodPost, "acc.gl_journal:audit", withID(server.AuditAccGlJournal)},
		{"cancel journal", http.MethodPost, "acc.gl_journal:cancel", withID(server.CancelAccGlJournal)},
		{"query journal lines", http.MethodPost, "acc.gl_journal:read", server.QueryAccGlJournalLines},
		{"get journal line", http.MethodGet, "acc.gl_journal:read", withID(server.GetAccGlJournalLine)},
		{"create journal line", http.MethodPost, "acc.gl_journal:create", server.CreateAccGlJournalLine},
		{"update journal line", http.MethodPatch, "acc.gl_journal:update", withID(server.UpdateAccGlJournalLine)},
		{"delete journal line", http.MethodDelete, "acc.gl_journal:delete", withID(server.DeleteAccGlJournalLine)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := inventoryRequest(tc.method, "{", nil)
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("without permission status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestGLJournalBodyHandlersAuthorizeBeforeJSONValidation(t *testing.T) {
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
		{"query journals", http.MethodPost, "acc.gl_journal:read", server.QueryAccGlJournals},
		{"create journal", http.MethodPost, "acc.gl_journal:create", server.CreateAccGlJournal},
		{"update journal", http.MethodPatch, "acc.gl_journal:update", withID(server.UpdateAccGlJournal)},
		{"audit journal", http.MethodPost, "acc.gl_journal:audit", withID(server.AuditAccGlJournal)},
		{"query journal lines", http.MethodPost, "acc.gl_journal:read", server.QueryAccGlJournalLines},
		{"create journal line", http.MethodPost, "acc.gl_journal:create", server.CreateAccGlJournalLine},
		{"update journal line", http.MethodPatch, "acc.gl_journal:update", withID(server.UpdateAccGlJournalLine)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := inventoryRequest(tc.method, "{", map[string]struct{}{tc.permission: {}})
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("with permission invalid JSON status = %d, body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestOptionalDateUpdate(t *testing.T) {
	value, err := optionalDateUpdate([]byte(`"2026-07-26"`))
	if err != nil || !value.Set || value.Value == nil || value.Value.Format("2006-01-02") != "2026-07-26" {
		t.Fatalf("valid date = %#v, err=%v", value, err)
	}
	value, err = optionalDateUpdate([]byte(`null`))
	if err != nil || !value.Set || value.Value != nil {
		t.Fatalf("null date = %#v, err=%v", value, err)
	}
	value, err = optionalDateUpdate(nil)
	if err != nil || value.Set {
		t.Fatalf("omitted date = %#v, err=%v", value, err)
	}
	if _, err := optionalDateUpdate([]byte(`"2026-99-99"`)); err == nil {
		t.Fatal("invalid date should fail")
	}
}

func TestJournalDTOUsesDateAndDecimalStrings(t *testing.T) {
	date := time.Date(2026, 7, 26, 13, 45, 0, 0, time.UTC)
	item := journalDTO(gljournal.Journal{
		Date: date, PostingDate: &date,
		DebitTotal:  decimal.RequireFromString("123.4500"),
		CreditTotal: decimal.RequireFromString("123.4500"),
	})
	if item["date"] != "2026-07-26" || *(item["postingDate"].(*string)) != "2026-07-26" {
		t.Fatalf("dates = %#v, %#v", item["date"], item["postingDate"])
	}
	if item["debitTotal"] != "123.45" || item["creditTotal"] != "123.45" {
		t.Fatalf("totals = %#v, %#v", item["debitTotal"], item["creditTotal"])
	}
}
