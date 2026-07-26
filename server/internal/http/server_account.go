package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryBasAccounts(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.account:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Limit  *int                       `json:"limit,omitempty"`
		Offset *int                       `json:"offset,omitempty"`
		Search *string                    `json:"search,omitempty"`
		Sort   *gen.Sort                  `json:"sort,omitempty"`
		Filter map[string]json.RawMessage `json:"filter,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := account.ListQuery{Filter: body.Filter}
	if body.Limit != nil {
		query.Limit = *body.Limit
	}
	if body.Offset != nil {
		query.Offset = *body.Offset
	}
	if body.Search != nil {
		query.Search = *body.Search
	}
	if body.Sort != nil {
		query.Sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	result, err := s.accounts.List(r.Context(), actor, query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Account, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, accountDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.AccountList{Count: result.Count, Results: items})
}

func (s *Server) GetBasAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.account:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.accounts.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, accountDTO(item))
}

func (s *Server) CreateBasAccount(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.account:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AccountCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	isGroup := false
	if body.IsGroup != nil {
		isGroup = *body.IsGroup
	}
	var role *string
	if body.Role != nil {
		value := string(*body.Role)
		role = &value
	}
	item, err := s.accounts.Create(r.Context(), actor, account.CreateInput{
		Code: body.Code, Name: body.Name, Direction: string(body.Direction),
		IsGroup: isGroup, Active: body.Active, Role: role, ParentID: body.ParentId,
		CompanyID: body.CompanyId, CurrencyID: body.CurrencyId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, accountDTO(item))
}

func (s *Server) UpdateBasAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.account:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name       *string         `json:"name,omitempty"`
		Direction  *string         `json:"direction,omitempty"`
		IsGroup    *bool           `json:"isGroup,omitempty"`
		Active     *bool           `json:"active,omitempty"`
		Role       json.RawMessage `json:"role,omitempty"`
		ParentID   json.RawMessage `json:"parentId,omitempty"`
		CurrencyID json.RawMessage `json:"currencyId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := account.UpdateInput{
		Name: body.Name, Direction: body.Direction, IsGroup: body.IsGroup, Active: body.Active,
	}
	if body.Role != nil {
		var value *string
		if err := json.Unmarshal(body.Role, &value); err != nil {
			s.writeError(w, r, nullableFieldError("role", "科目角色"))
			return
		}
		input.Role = &value
	}
	if body.ParentID != nil {
		var value *uuid.UUID
		if err := json.Unmarshal(body.ParentID, &value); err != nil {
			s.writeError(w, r, nullableFieldError("parentId", "UUID"))
			return
		}
		input.ParentID = &value
	}
	if body.CurrencyID != nil {
		var value *uuid.UUID
		if err := json.Unmarshal(body.CurrencyID, &value); err != nil {
			s.writeError(w, r, nullableFieldError("currencyId", "UUID"))
			return
		}
		input.CurrencyID = &value
	}
	item, err := s.accounts.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, accountDTO(item))
}

func (s *Server) DeleteBasAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.account:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.accounts.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) InitializeBasAccountsTemplate(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.account:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AccountTemplateInitialize
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.accounts.InitializeTemplate(r.Context(), actor, body.CompanyId, string(body.Template))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, gen.AccountTemplateResult{CreatedCount: result.CreatedCount})
}

func nullableFieldError(field, expected string) error {
	return apierror.Validation("会计科目参数不合法", map[string][]string{
		field: {"必须是 " + expected + " 或 null"},
	})
}

func accountDTO(item account.Account) gen.Account {
	result := gen.Account{
		Id: item.ID, Code: item.Code, Name: item.Name,
		Direction: gen.AccountDirection(item.Direction), IsGroup: item.IsGroup, Active: item.Active,
		CompanyId: item.CompanyID, Company: gen.AccountReference{Id: item.Company.ID, Name: item.Company.Name},
		HasChildren: item.HasChildren, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		ParentId: item.ParentID, CurrencyId: item.CurrencyID,
	}
	if item.Role != nil {
		value := gen.AccountRole(*item.Role)
		result.Role = &value
	}
	if item.Parent != nil {
		result.Parent = &gen.AccountReference{Id: item.Parent.ID, Name: item.Parent.Name}
	}
	if item.Currency != nil {
		result.Currency = &gen.AccountReference{Id: item.Currency.ID, Name: item.Currency.Name}
	}
	return result
}
