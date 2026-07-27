package httpapi

import (
	"net/http"

	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/http/gen"
)

func unitListQuery(body listBody) unit.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return unit.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryBasUnits(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "base.unit:read", unitListQuery, ignoreActor(s.Units.List),
		func(result unit.ListResult) any {
			return gen.UnitList{Count: result.Count, Results: mapItems(result.Results, unitDTO)}
		})
}
func (s *Server) GetBasUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if e := requirePermission(r, "base.unit:read"); e != nil {
		s.writeError(w, r, e)
		return
	}
	x, e := s.Units.Get(r.Context(), id)
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
	x, e := s.Units.Create(r.Context(), a, unit.CreateInput{UnitType: string(b.UnitType), IsBase: b.IsBase, Name: b.Name, Symbol: b.Symbol, Ratio: b.Ratio})
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
	x, e := s.Units.Update(r.Context(), a, id, unit.UpdateInput{UnitType: t, IsBase: b.IsBase, Name: b.Name, Symbol: b.Symbol, Ratio: b.Ratio})
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
	if e = s.Units.Delete(r.Context(), a, id); e != nil {
		s.writeError(w, r, e)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func unitDTO(x unit.Unit) gen.Unit {
	return gen.Unit{Id: x.ID, UnitType: gen.UnitType(x.UnitType), IsBase: x.IsBase, Name: x.Name, Symbol: x.Symbol, Ratio: x.Ratio.String(), InsertedAt: x.InsertedAt, UpdatedAt: x.UpdatedAt}
}
