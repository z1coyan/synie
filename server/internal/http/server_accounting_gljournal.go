package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryAccGlJournals(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.gl_journal:read")
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
	result, err := s.glJournals.List(r.Context(), actor, gljournal.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, journalListDTO(result))
}

func (s *Server) GetAccGlJournal(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.glJournals.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, journalDTO(item))
}

func (s *Server) CreateAccGlJournal(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.gl_journal:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.GLJournalCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.glJournals.Create(r.Context(), actor, gljournal.CreateInput{
		VoucherNo: body.VoucherNo, Date: body.Date.Time,
		PostingDate: datePointer(body.PostingDate), Remarks: body.Remarks,
		CompanyID: body.CompanyId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, journalDTO(item))
}

func (s *Server) UpdateAccGlJournal(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		VoucherNo   *string             `json:"voucherNo,omitempty"`
		Date        *openapi_types.Date `json:"date,omitempty"`
		PostingDate json.RawMessage     `json:"postingDate,omitempty"`
		Remarks     json.RawMessage     `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	postingDate, err := nullableDateUpdate(body.PostingDate)
	if err != nil {
		s.writeError(w, r, nullableDateError("手工会计凭证", "postingDate"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工会计凭证", "remarks"))
		return
	}
	item, err := s.glJournals.Update(r.Context(), actor, id, gljournal.UpdateInput{
		VoucherNo: body.VoucherNo, Date: datePointer(body.Date),
		PostingDate: postingDate, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, journalDTO(item))
}

func (s *Server) DeleteAccGlJournal(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.glJournals.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditAccGlJournal(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:audit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.GLJournalAudit
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.glJournals.Audit(r.Context(), actor, id, datePointer(body.PostingDate))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, journalDTO(item))
}

func (s *Server) CancelAccGlJournal(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:cancel")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.glJournals.Cancel(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, journalDTO(item))
}

func (s *Server) QueryAccGlJournalLines(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.gl_journal:read")
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
	result, err := s.glJournals.ListLines(r.Context(), actor, gljournal.ListLineQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetAccGlJournalLine(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.glJournals.GetLine(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateAccGlJournalLine(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.gl_journal:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.GLJournalLineCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	debit, err := decimalInput(body.Debit, "手工会计凭证行", "debit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	credit, err := decimalInput(body.Credit, "手工会计凭证行", "credit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.glJournals.CreateLine(r.Context(), actor, gljournal.CreateLineInput{
		JournalID: body.JournalId, Idx: body.Idx, AccountID: body.AccountId,
		Debit: debit, Credit: credit, PartyType: partyTypePointer(body.PartyType),
		PartyID: body.PartyId, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateAccGlJournalLine(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Idx       *int64          `json:"idx,omitempty"`
		AccountID *uuid.UUID      `json:"accountId,omitempty"`
		Debit     *string         `json:"debit,omitempty"`
		Credit    *string         `json:"credit,omitempty"`
		PartyType json.RawMessage `json:"partyType,omitempty"`
		PartyID   json.RawMessage `json:"partyId,omitempty"`
		Remarks   json.RawMessage `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	debit, err := optionalDecimalInput(body.Debit, "手工会计凭证行", "debit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	credit, err := optionalDecimalInput(body.Credit, "手工会计凭证行", "credit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	partyType, err := nullableStringUpdate(body.PartyType)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工会计凭证行", "partyType"))
		return
	}
	partyID, err := nullableUUIDUpdate(body.PartyID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("手工会计凭证行", "partyId"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工会计凭证行", "remarks"))
		return
	}
	item, err := s.glJournals.UpdateLine(r.Context(), actor, id, gljournal.UpdateLineInput{
		Idx: body.Idx, AccountID: body.AccountID, Debit: debit, Credit: credit,
		PartyType: partyType, PartyID: partyID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteAccGlJournalLine(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.gl_journal:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.glJournals.DeleteLine(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func datePointer(value *openapi_types.Date) *time.Time {
	if value == nil {
		return nil
	}
	result := value.Time
	return &result
}

func nullableDateUpdate(raw json.RawMessage) (**time.Time, error) {
	if raw == nil {
		return nil, nil
	}
	var value *openapi_types.Date
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if value == nil {
		var result *time.Time
		return &result, nil
	}
	date := value.Time
	result := &date
	return &result, nil
}

func nullableDateError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是 YYYY-MM-DD 日期或 null"},
	})
}

func partyTypePointer(value *gen.GLPartyType) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}

func journalListDTO(result gljournal.ListResult) map[string]any {
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = journalDTO(item)
	}
	return map[string]any{"count": result.Count, "results": items}
}

func journalDTO(item gljournal.Journal) map[string]any {
	var postingDate *string
	if item.PostingDate != nil {
		value := item.PostingDate.Format(time.DateOnly)
		postingDate = &value
	}
	return map[string]any{
		"id": item.ID, "voucherNo": item.VoucherNo, "date": item.Date.Format(time.DateOnly),
		"postingDate": postingDate, "remarks": item.Remarks, "status": item.Status,
		"submittedAt": item.SubmittedAt, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"companyId": item.CompanyID, "createdById": item.CreatedByID, "submittedById": item.SubmittedByID,
		"debitTotal": item.DebitTotal.String(), "creditTotal": item.CreditTotal.String(),
		"company": item.Company, "createdBy": item.CreatedBy, "submittedBy": item.SubmittedBy,
	}
}
