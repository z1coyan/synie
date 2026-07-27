package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/systemops"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func systemopsListQuery(body listBody) systemops.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return systemops.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QuerySystemAuditLogs(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "sys.audit_log:read", systemopsListQuery,
		func(ctx context.Context, actor *authz.Actor, query systemops.ListQuery) (gen.SystemAuditLogList, error) {
			result, err := s.SystemOps.QueryAuditLogs(ctx, actor, query)
			if err != nil {
				return gen.SystemAuditLogList{}, err
			}
			items := make([]gen.SystemAuditLog, 0, len(result.Results))
			for _, item := range result.Results {
				dto, dtoErr := systemAuditLogDTO(item)
				if dtoErr != nil {
					return gen.SystemAuditLogList{}, dtoErr
				}
				items = append(items, dto)
			}
			return gen.SystemAuditLogList{Count: result.Count, Results: items}, nil
		}, passthroughListResponse)
}

func (s *Server) GetSystemAuditLog(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.audit_log:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.SystemOps.GetAuditLog(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	dto, err := systemAuditLogDTO(item)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, dto)
}

type todoQueryBody struct {
	Limit            *int                       `json:"limit,omitempty"`
	Offset           *int                       `json:"offset,omitempty"`
	Search           *string                    `json:"search,omitempty"`
	Sort             *gen.Sort                  `json:"sort,omitempty"`
	Filter           map[string]json.RawMessage `json:"filter,omitempty"`
	Tab              *string                    `json:"tab,omitempty"`
	IncludeDismissed *bool                      `json:"includeDismissed,omitempty"`
}

func (s *Server) QueryTodos(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body todoQueryBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := systemops.TodoListQuery{
		ListQuery: systemops.ListQuery{
			Limit: valueOrZero(body.Limit), Offset: valueOrZero(body.Offset),
			Search: stringOrEmpty(body.Search), Filter: body.Filter,
		},
		Tab: stringOrEmpty(body.Tab), IncludeDismissed: boolOrFalse(body.IncludeDismissed),
	}
	if body.Sort != nil {
		query.Sort = &filterbuild.Sort{
			Column: body.Sort.Column, Direction: string(body.Sort.Direction),
		}
	}
	result, err := s.SystemOps.ListTodos(r.Context(), actor, query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Todo, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, todoDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.TodoList{Count: result.Count, Results: items})
}

func (s *Server) MarkTodoRead(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.updateTodoState(w, r, id, false)
}

func (s *Server) DismissTodo(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.updateTodoState(w, r, id, true)
}

func (s *Server) updateTodoState(
	w http.ResponseWriter,
	r *http.Request,
	id uuid.UUID,
	dismiss bool,
) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var item systemops.Todo
	if dismiss {
		item, err = s.SystemOps.Dismiss(r.Context(), actor, id)
	} else {
		item, err = s.SystemOps.MarkRead(r.Context(), actor, id)
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, todoDTO(item))
}

func systemAuditLogDTO(item systemops.AuditLog) (gen.SystemAuditLog, error) {
	changes := make(map[string]interface{})
	if err := json.Unmarshal(item.Changes, &changes); err != nil {
		return gen.SystemAuditLog{}, apierror.Wrap(
			apierror.CodeInternal, "读取操作日志变更内容失败", err,
		)
	}
	return gen.SystemAuditLog{
		Id: item.ID, InsertedAt: item.InsertedAt,
		Resource: item.Resource, RecordId: item.RecordID, RecordLabel: item.RecordLabel,
		ActionType: item.ActionType, ActionName: item.ActionName,
		ActorId: item.ActorID, ActorName: item.ActorName, CompanyId: item.CompanyID,
		Changes: changes,
	}, nil
}

func todoDTO(item systemops.Todo) gen.Todo {
	dto := gen.Todo{
		Id: item.ID, Type: gen.TodoType(item.Type),
		SourceType: item.SourceType, SourceId: item.SourceID, SourceNo: item.SourceNo,
		PartyType: item.PartyType, PartyId: item.PartyID, PartyName: item.PartyName,
		Amount: item.Amount.String(), Status: gen.TodoStatus(item.Status),
		SourceChangedAt: item.SourceChangedAt, ClosedAt: item.ClosedAt,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		DraftInvoiceLinked: item.DraftInvoiceLinked,
		MyReadAt:           item.MyReadAt, MyDismissedAt: item.MyDismissedAt,
		Dismissed: item.Dismissed, CompanyId: item.CompanyID,
		CreatedById: item.CreatedByID,
		Company: &gen.TodoCompanyReference{
			Id: item.Company.ID, Name: item.Company.Name, ShortName: item.Company.ShortName,
		},
	}
	if item.ClosedReason != nil {
		reason := gen.TodoClosedReason(*item.ClosedReason)
		dto.ClosedReason = &reason
	}
	if item.CreatedBy != nil {
		dto.CreatedBy = &gen.TodoUserReference{
			Id: item.CreatedBy.ID, Username: item.CreatedBy.Username, Name: item.CreatedBy.Name,
		}
	}
	return dto
}

func valueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func boolOrFalse(value *bool) bool {
	return value != nil && *value
}
