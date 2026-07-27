package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func companyListQuery(body listBody) company.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return company.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryBasCompanies(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "base.company:read", companyListQuery, ignoreActor(s.Companies.List),
		func(result company.ListResult) any {
			return gen.CompanyList{Count: result.Count, Results: mapItems(result.Results, companyDTO)}
		})
}

func (s *Server) GetBasCompany(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.company:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Companies.Get(r.Context(), id)
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
	item, err := s.Companies.Create(r.Context(), actor, company.CreateInput{
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
	item, err := s.Companies.Update(r.Context(), actor, id, input)
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
	if err := s.Companies.Delete(r.Context(), actor, id); err != nil {
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
