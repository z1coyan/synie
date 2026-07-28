package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestInitializeBasAccountsTemplateRejectsActorWithoutCreatePermission(t *testing.T) {
	t.Parallel()
	server := &Server{Dependencies: Dependencies{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/base/accounts/init-template", strings.NewReader(`{
		"companyId":"00000000-0000-0000-0000-000000000001",
		"template":"SMALL"
	}`))
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, &authz.Actor{
		UserID: uuid.New(), Username: "restricted",
		Permissions: map[string]struct{}{"base.account:read": {}},
	}))
	response := httptest.NewRecorder()

	server.InitializeBasAccountsTemplate(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "forbidden" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}
