package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryBasCompanies(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.company:read"); err != nil {
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
	query := company.ListQuery{Filter: body.Filter}
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
	result, err := s.companies.List(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Company, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, companyDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.CompanyList{Count: result.Count, Results: items})
}

func (s *Server) GetBasCompany(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.company:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.companies.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, companyDTO(item))
}

func (s *Server) CreateBasCompany(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.company:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.CompanyCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.companies.Create(r.Context(), actor, company.CreateInput{
		Code: body.Code, Name: body.Name, ShortName: body.ShortName,
		ParentID: body.ParentId, BaseCurrencyID: body.BaseCurrencyId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, companyDTO(item))
}

func (s *Server) UpdateBasCompany(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.company:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name           *string         `json:"name,omitempty"`
		ShortName      *string         `json:"shortName,omitempty"`
		ParentID       json.RawMessage `json:"parentId,omitempty"`
		BaseCurrencyID *uuid.UUID      `json:"baseCurrencyId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := company.UpdateInput{Name: body.Name, ShortName: body.ShortName, BaseCurrencyID: body.BaseCurrencyID}
	if body.ParentID != nil {
		var parentID *uuid.UUID
		if err := json.Unmarshal(body.ParentID, &parentID); err != nil {
			s.writeError(w, r, apierror.Validation("公司参数不合法", map[string][]string{"parentId": {"必须是 UUID 或 null"}}))
			return
		}
		input.ParentID = &parentID
	}
	item, err := s.companies.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, companyDTO(item))
}

func (s *Server) DeleteBasCompany(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.company:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.companies.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func companyDTO(item company.Company) gen.Company {
	result := gen.Company{
		Id: item.ID, Code: item.Code, Name: item.Name, ShortName: item.ShortName,
		ParentId: item.ParentID, BaseCurrencyId: item.BaseCurrencyID,
		BaseCurrency: gen.CompanyReference{Id: item.BaseCurrency.ID, Name: item.BaseCurrency.Name},
		InsertedAt:   item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
	if item.Parent != nil {
		result.Parent = &gen.CompanyReference{Id: item.Parent.ID, Name: item.Parent.Name}
	}
	return result
}
