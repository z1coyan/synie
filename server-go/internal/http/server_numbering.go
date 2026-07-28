package httpapi

import (
	"net/http"

	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const numberingPermission = "sys.numbering_rule"

func numberingRuleListQuery(body listBody) numbering.RuleListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return numbering.RuleListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func numberingCounterListQuery(body listBody) numbering.CounterListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return numbering.CounterListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) ListNumberableResources(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, numberingPermission+":read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	resources := s.Numbering.NumberableResources()
	result := make([]gen.NumberableResource, 0, len(resources))
	for _, resource := range resources {
		fields := make([]gen.NumberableField, 0, len(resource.Fields))
		for _, field := range resource.Fields {
			fields = append(fields, gen.NumberableField{
				Path: field.Path, Label: field.Label, Type: gen.NumberableFieldType(field.Type),
			})
		}
		result = append(result, gen.NumberableResource{
			Prefix: resource.Prefix, Grid: resource.Grid, Fields: fields,
		})
	}
	s.writeJSON(w, http.StatusOK, gen.NumberableResourceList{Resources: result})
}

func (s *Server) QuerySysNumberingRules(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, numberingPermission+":read", numberingRuleListQuery,
		ignoreActor(s.Numbering.ListRules),
		func(result numbering.RuleList) any {
			return gen.NumberingRuleList{
				Count: result.Count, Results: mapItems(result.Results, numberingRuleDTO),
			}
		})
}

func (s *Server) GetSysNumberingRule(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, numberingPermission+":read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Numbering.GetRule(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, numberingRuleDTO(item))
}

func (s *Server) CreateSysNumberingRule(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, numberingPermission+":create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.NumberingRuleCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.Numbering.Create(r.Context(), actor, numbering.CreateInput{
		Resource: body.Resource, Name: body.Name, Segments: numberingSegments(body.Segments),
		PerCompany: body.PerCompany, Enabled: body.Enabled,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, numberingRuleDTO(item))
}

func (s *Server) UpdateSysNumberingRule(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, numberingPermission+":update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.NumberingRuleUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var segments *[]numbering.Segment
	if body.Segments != nil {
		converted := numberingSegments(*body.Segments)
		segments = &converted
	}
	item, err := s.Numbering.UpdateRule(r.Context(), actor, id, numbering.UpdateInput{
		Name: body.Name, Segments: segments, PerCompany: body.PerCompany, Enabled: body.Enabled,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, numberingRuleDTO(item))
}

func (s *Server) DeleteSysNumberingRule(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, numberingPermission+":delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.Numbering.DeleteRule(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QuerySysNumberingCounters(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, numberingPermission+":read", numberingCounterListQuery,
		ignoreActor(s.Numbering.ListCounters),
		func(result numbering.CounterList) any {
			return gen.NumberingCounterList{
				Count: result.Count, Results: mapItems(result.Results, numberingCounterDTO),
			}
		})
}

func (s *Server) GetSysNumberingCounter(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, numberingPermission+":read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Numbering.GetCounter(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, numberingCounterDTO(item))
}

func (s *Server) UpdateSysNumberingCounter(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, numberingPermission+":update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.NumberingCounterUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.Numbering.UpdateCounter(r.Context(), actor, id, body.Value)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, numberingCounterDTO(item))
}

func numberingSegments(items []gen.NumberingSegment) []numbering.Segment {
	result := make([]numbering.Segment, 0, len(items))
	for _, item := range items {
		result = append(result, numbering.Segment{
			Type: string(item.Type), Value: item.Value, Field: item.Field,
			Label: item.Label, Format: item.Format, Padding: item.Padding,
		})
	}
	return result
}

func numberingSegmentDTOs(items []numbering.Segment) []gen.NumberingSegment {
	result := make([]gen.NumberingSegment, 0, len(items))
	for _, item := range items {
		result = append(result, gen.NumberingSegment{
			Type: gen.NumberingSegmentType(item.Type), Value: item.Value, Field: item.Field,
			Label: item.Label, Format: item.Format, Padding: item.Padding,
		})
	}
	return result
}

func numberingRuleDTO(item numbering.Rule) gen.NumberingRule {
	return gen.NumberingRule{
		Id: item.ID, Resource: item.Resource, Name: item.Name,
		Segments: numberingSegmentDTOs(item.Segments), PerCompany: item.PerCompany,
		Enabled: item.Enabled, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func numberingCounterDTO(item numbering.Counter) gen.NumberingCounter {
	return gen.NumberingCounter{
		Id: item.ID, RuleId: item.RuleID, ScopeKey: item.ScopeKey, Value: item.Value,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}
