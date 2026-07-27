package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func accountListQuery(body listBody) account.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return account.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryBasAccounts(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "base.account:read", accountListQuery, s.Accounts.List,
		func(result account.ListResult) any {
			return gen.AccountList{Count: result.Count, Results: mapItems(result.Results, accountDTO)}
		})
}

func (s *Server) GetBasAccount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.account:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Accounts.Get(r.Context(), actor, id)
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
	item, err := s.Accounts.Create(r.Context(), actor, account.CreateInput{
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
	role, err := optionalUpdate[string](body.Role)
	if err != nil {
		s.writeError(w, r, nullableFieldError("role", "科目角色"))
		return
	}
	parentID, err := optionalUpdate[uuid.UUID](body.ParentID)
	if err != nil {
		s.writeError(w, r, nullableFieldError("parentId", "UUID"))
		return
	}
	currencyID, err := optionalUpdate[uuid.UUID](body.CurrencyID)
	if err != nil {
		s.writeError(w, r, nullableFieldError("currencyId", "UUID"))
		return
	}
	input := account.UpdateInput{
		Name: body.Name, Direction: body.Direction, IsGroup: body.IsGroup, Active: body.Active,
		Role: role, ParentID: parentID, CurrencyID: currencyID,
	}
	item, err := s.Accounts.Update(r.Context(), actor, id, input)
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
	if err := s.Accounts.Delete(r.Context(), actor, id); err != nil {
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
	result, err := s.Accounts.InitializeTemplate(r.Context(), actor, body.CompanyId, string(body.Template))
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
