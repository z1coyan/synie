package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/accounting/glentry"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryAccGlEntries(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.gl_entry:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.glEntries.List(r.Context(), actor, glentry.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetAccGlEntry(w http.ResponseWriter, r *http.Request, id string) {
	actor, err := actorWithPermission(r, "acc.gl_entry:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	entryID, err := uuid.Parse(id)
	if err != nil {
		s.writeError(w, r, apierror.Validation("总账分录参数不合法", map[string][]string{
			"id": {"必须是 UUID"},
		}))
		return
	}
	item, err := s.glEntries.Get(r.Context(), actor, entryID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) GetAccARAPReport(
	w http.ResponseWriter,
	r *http.Request,
	params gen.GetAccARAPReportParams,
) {
	actor, err := actorWithPermission(r, "acc.gl_entry:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	companyID, asOf, fields := parseARAPReportParams(params)
	if len(fields) != 0 {
		s.writeError(w, r, apierror.Validation("应收应付报表参数不合法", fields))
		return
	}
	result, err := s.glEntries.Report(r.Context(), actor, glentry.ReportQuery{
		CompanyID: companyID,
		AsOf:      asOf,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func parseARAPReportParams(params gen.GetAccARAPReportParams) (
	uuid.UUID,
	time.Time,
	map[string][]string,
) {
	fields := make(map[string][]string)
	var companyID uuid.UUID
	if params.CompanyId == nil || strings.TrimSpace(*params.CompanyId) == "" {
		fields["companyId"] = []string{"必填"}
	} else {
		parsed, err := uuid.Parse(strings.TrimSpace(*params.CompanyId))
		if err != nil {
			fields["companyId"] = []string{"必须是 UUID"}
		} else {
			companyID = parsed
		}
	}
	var asOf time.Time
	if params.AsOf == nil || strings.TrimSpace(*params.AsOf) == "" {
		fields["asOf"] = []string{"必填"}
	} else {
		parsed, err := time.Parse(time.DateOnly, strings.TrimSpace(*params.AsOf))
		if err != nil {
			fields["asOf"] = []string{"必须是 YYYY-MM-DD 日期"}
		} else {
			asOf = parsed
		}
	}
	return companyID, asOf, fields
}
