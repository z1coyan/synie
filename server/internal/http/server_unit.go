package httpapi

import (
	"encoding/json"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"net/http"
)

func (s *Server) QueryBasUnits(w http.ResponseWriter, r *http.Request) {
	if e := requirePermission(r, "base.unit:read"); e != nil {
		s.writeError(w, r, e)
		return
	}
	var b struct {
		Limit, Offset *int
		Search        *string
		Sort          *gen.Sort
		Filter        map[string]json.RawMessage
	}
	if e := decodeJSON(w, r, &b); e != nil {
		s.writeError(w, r, invalidJSON(e))
		return
	}
	q := unit.ListQuery{Filter: b.Filter}
	if b.Limit != nil {
		q.Limit = *b.Limit
	}
	if b.Offset != nil {
		q.Offset = *b.Offset
	}
	if b.Search != nil {
		q.Search = *b.Search
	}
	if b.Sort != nil {
		q.Sort = &filterbuild.Sort{Column: b.Sort.Column, Direction: string(b.Sort.Direction)}
	}
	x, e := s.units.List(r.Context(), q)
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	out := make([]gen.Unit, 0, len(x.Results))
	for _, v := range x.Results {
		out = append(out, unitDTO(v))
	}
	s.writeJSON(w, http.StatusOK, gen.UnitList{Count: x.Count, Results: out})
}
func (s *Server) GetBasUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if e := requirePermission(r, "base.unit:read"); e != nil {
		s.writeError(w, r, e)
		return
	}
	x, e := s.units.Get(r.Context(), id)
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	s.writeJSON(w, http.StatusOK, unitDTO(x))
}
func (s *Server) CreateBasUnit(w http.ResponseWriter, r *http.Request) {
	a, e := actorWithPermission(r, "base.unit:create")
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	var b gen.UnitCreate
	if e = decodeJSON(w, r, &b); e != nil {
		s.writeError(w, r, invalidJSON(e))
		return
	}
	x, e := s.units.Create(r.Context(), a, unit.CreateInput{UnitType: string(b.UnitType), IsBase: b.IsBase, Name: b.Name, Symbol: b.Symbol, Ratio: b.Ratio})
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	s.writeJSON(w, http.StatusCreated, unitDTO(x))
}
func (s *Server) UpdateBasUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	a, e := actorWithPermission(r, "base.unit:update")
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	var b gen.UnitUpdate
	if e = decodeJSON(w, r, &b); e != nil {
		s.writeError(w, r, invalidJSON(e))
		return
	}
	var t *string
	if b.UnitType != nil {
		v := string(*b.UnitType)
		t = &v
	}
	x, e := s.units.Update(r.Context(), a, id, unit.UpdateInput{UnitType: t, IsBase: b.IsBase, Name: b.Name, Symbol: b.Symbol, Ratio: b.Ratio})
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	s.writeJSON(w, http.StatusOK, unitDTO(x))
}
func (s *Server) DeleteBasUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	a, e := actorWithPermission(r, "base.unit:delete")
	if e != nil {
		s.writeError(w, r, e)
		return
	}
	if e = s.units.Delete(r.Context(), a, id); e != nil {
		s.writeError(w, r, e)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func unitDTO(x unit.Unit) gen.Unit {
	return gen.Unit{Id: x.ID, UnitType: gen.UnitType(x.UnitType), IsBase: x.IsBase, Name: x.Name, Symbol: x.Symbol, Ratio: x.Ratio.String(), InsertedAt: x.InsertedAt, UpdatedAt: x.UpdatedAt}
}
