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
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	setupplatform "github.com/z1coyan/synie/server/internal/platform/setup"
)

type setupStub struct {
	firstInput setupplatform.FirstUserInput
	language   string
	seedSample bool
	actor      *authz.Actor
	err        error
}

func (s *setupStub) CreateFirstUser(_ context.Context, input setupplatform.FirstUserInput) (setupplatform.FirstUserResult, error) {
	s.firstInput = input
	if s.err != nil {
		return setupplatform.FirstUserResult{}, s.err
	}
	name := "管理员"
	return setupplatform.FirstUserResult{
		Token: "jwt", ExpiresAt: time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC),
		User: auth.User{ID: uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), Username: input.Username, Name: &name},
	}, nil
}
func (s *setupStub) SeedCommonCurrencies(context.Context) (int, error)     { return 19, s.err }
func (s *setupStub) ActivateBaseCurrency(context.Context, uuid.UUID) error { return s.err }
func (s *setupStub) Complete(_ context.Context, actor *authz.Actor, language string, seed bool) error {
	s.actor, s.language, s.seedSample = actor, language, seed
	return s.err
}

func setupTestServer(stub setupHTTPService) *Server {
	return &Server{Dependencies: Dependencies{Setup: stub, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}
}

func TestCreateSetupFirstUserPublicReturnsJWT(t *testing.T) {
	stub := &setupStub{}
	server := setupTestServer(stub)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/setup/first-user", strings.NewReader(`{"username":"admin","name":"管理员","password":"admin123"}`))
	response := httptest.NewRecorder()
	server.CreateSetupFirstUser(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Token string `json:"token"`
		User  struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Token != "jwt" || body.User.Username != "admin" || stub.firstInput.Password != "admin123" {
		t.Fatalf("unexpected body/input: %+v %+v", body, stub.firstInput)
	}
}

func TestSetupProtectedEndpointsRequireSuperAdminBeforeService(t *testing.T) {
	server := setupTestServer(&setupStub{})
	actor := &authz.Actor{UserID: uuid.New(), Username: "normal"}
	cases := []struct {
		name, body string
		handler    http.HandlerFunc
	}{
		{"seed", `{}`, server.SeedSetupCommonCurrencies},
		{"activate", `{"currencyId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}`, server.ActivateSetupBaseCurrency},
		{"complete", `{"preferredLanguage":"zh-CN"}`, server.CompleteSetup},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, actor))
			response := httptest.NewRecorder()
			tc.handler(response, request)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"forbidden"`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestCompleteSetupPropagatesNotImplementedEnvelope(t *testing.T) {
	stub := &setupStub{err: apierror.New(apierror.CodeNotImplemented, "sample 未迁移")}
	server := setupTestServer(stub)
	actor := &authz.Actor{UserID: uuid.New(), Username: "admin", SuperAdmin: true}
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"preferredLanguage":"zh-CN","seedSampleData":true}`))
	request = request.WithContext(context.WithValue(request.Context(), actorContextKey{}, actor))
	response := httptest.NewRecorder()
	server.CompleteSetup(response, request)
	if response.Code != http.StatusNotImplemented || !strings.Contains(response.Body.String(), `"code":"not_implemented"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !stub.seedSample || stub.language != "zh-CN" {
		t.Fatalf("service arguments not propagated: language=%s seed=%v", stub.language, stub.seedSample)
	}
}
