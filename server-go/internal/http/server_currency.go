package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/z1coyan/synie/server/internal/domain/base/currency"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func currencyListQuery(body listBody) currency.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return currency.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryBasCurrencies(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "base.currency:read", currencyListQuery, ignoreActor(s.Currencies.List),
		func(result currency.ListResult) any {
			return gen.CurrencyList{Count: result.Count, Results: mapItems(result.Results, currencyDTO)}
		})
}

func (s *Server) GetBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.currency:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Currencies.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, currencyDTO(item))
}

func (s *Server) CreateBasCurrency(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.currency:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.CurrencyCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.Currencies.Create(r.Context(), actor, currency.CreateInput{
		Name: body.Name, ISOCode: body.IsoCode, Symbol: body.Symbol, Active: body.Active,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, currencyDTO(item))
}

func (s *Server) UpdateBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.currency:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name   *string         `json:"name,omitempty"`
		Active *bool           `json:"active,omitempty"`
		Symbol json.RawMessage `json:"symbol,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := currency.UpdateInput{Name: body.Name, Active: body.Active}
	if body.Symbol != nil {
		input.Symbol.Set = true
		if string(body.Symbol) != "null" {
			var symbol string
			if err := json.Unmarshal(body.Symbol, &symbol); err != nil {
				s.writeError(w, r, apierror.Validation("币种参数不合法", map[string][]string{"symbol": {"必须是字符串或 null"}}))
				return
			}
			input.Symbol.Value = &symbol
		}
	}
	item, err := s.Currencies.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, currencyDTO(item))
}

func (s *Server) DeleteBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.currency:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.Currencies.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func currencyDTO(item currency.Currency) gen.Currency {
	return gen.Currency{
		Id: item.ID, Name: item.Name, IsoCode: item.ISOCode, Symbol: item.Symbol,
		Active: item.Active, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}
