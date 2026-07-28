package httpapi

import (
	"net/http"

	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	setupplatform "github.com/z1coyan/synie/server/internal/platform/setup"
)

func (s *Server) CreateSetupFirstUser(w http.ResponseWriter, r *http.Request) {
	var body gen.SetupFirstUserRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.Setup.CreateFirstUser(r.Context(), setupplatform.FirstUserInput{
		Username: body.Username, Name: body.Name, Password: body.Password,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusCreated, gen.LoginResponse{
		Token: result.Token, ExpiresAt: result.ExpiresAt,
		User: gen.SessionUser{Id: result.User.ID, Username: result.User.Username, Name: result.User.Name},
	})
}

func (s *Server) SeedSetupCommonCurrencies(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !actor.SuperAdmin {
		s.writeError(w, r, apierror.New(apierror.CodeForbidden, "仅超级管理员可执行初始化"))
		return
	}
	created, err := s.Setup.SeedCommonCurrencies(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.SetupSeedCurrenciesResponse{Created: created})
}

func (s *Server) ActivateSetupBaseCurrency(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !actor.SuperAdmin {
		s.writeError(w, r, apierror.New(apierror.CodeForbidden, "仅超级管理员可执行初始化"))
		return
	}
	var body gen.SetupActivateBaseCurrencyRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if err := s.Setup.ActivateBaseCurrency(r.Context(), body.CurrencyId); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.SetupSuccessResponse{Success: true})
}

func (s *Server) CompleteSetup(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !actor.SuperAdmin {
		s.writeError(w, r, apierror.New(apierror.CodeForbidden, "仅超级管理员可执行初始化"))
		return
	}
	var body gen.SetupCompleteRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	seedSampleData := body.SeedSampleData != nil && *body.SeedSampleData
	if err := s.Setup.Complete(r.Context(), actor, string(body.PreferredLanguage), seedSampleData); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.SetupSuccessResponse{Success: true})
}
