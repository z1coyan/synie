package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	outsourcedIssuePermission   = "purchase.outsourced_issue"
	outsourcedReceiptPermission = "purchase.outsourced_receipt"
)

// authorizeOutsourced 是路由门面的唯一鉴权点:鉴权通过后把 actor 显式传给内部实现。
func (s *Server) authorizeOutsourced(
	w http.ResponseWriter, r *http.Request, prefix, action string,
) *authz.Actor {
	actor, err := actorWithPermission(r, prefix+":"+action)
	if err != nil {
		s.writeError(w, r, err)
		return nil
	}
	return actor
}

func outsourcedListQuery(body listBody) outsourced.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return outsourced.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func getOutsourced[T any](
	s *Server,
	w http.ResponseWriter,
	r *http.Request,
	actor *authz.Actor,
	id uuid.UUID,
	get func(*authz.Actor, uuid.UUID) (T, error),
	dto func(T) map[string]any,
) {
	item, err := get(actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, dto(item))
}

func deleteOutsourced(
	s *Server,
	w http.ResponseWriter,
	r *http.Request,
	actor *authz.Actor,
	id uuid.UUID,
	del func(*authz.Actor, uuid.UUID) error,
) {
	if err := del(actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryPurchaseOutsourcedIssues(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListIssues,
		func(result outsourced.ListResult[outsourced.Issue]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedIssueDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.Issue, error) {
			return s.OutsourcedFulfillment.GetIssue(r.Context(), actor, id)
		}, outsourcedIssueDTO)
}

func (s *Server) DeletePurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteIssue(r.Context(), actor, id)
	})
}

type outsourcedIssueCreateBody struct {
	CompanyID             uuid.UUID           `json:"companyId"`
	IssueNo               *string             `json:"issueNo,omitempty"`
	IssueDate             *openapi_types.Date `json:"issueDate,omitempty"`
	PartyType             string              `json:"partyType"`
	PartyID               uuid.UUID           `json:"partyId"`
	Remarks               *string             `json:"remarks,omitempty"`
	FromWarehouseID       *uuid.UUID          `json:"fromWarehouseId,omitempty"`
	OutsourcedWarehouseID *uuid.UUID          `json:"outsourcedWarehouseId,omitempty"`
}

func (s *Server) CreatePurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedIssueCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.OutsourcedFulfillment.CreateIssue(r.Context(), actor, outsourced.CreateIssueInput{
		CompanyID: body.CompanyID, IssueNo: body.IssueNo, IssueDate: datePointer(body.IssueDate),
		PartyType: body.PartyType, PartyID: body.PartyID, Remarks: body.Remarks,
		FromWarehouseID: body.FromWarehouseID, OutsourcedWarehouseID: body.OutsourcedWarehouseID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedIssueDTO(item))
}

type outsourcedIssueUpdateBody struct {
	IssueNo               *string             `json:"issueNo,omitempty"`
	IssueDate             *openapi_types.Date `json:"issueDate,omitempty"`
	PartyType             *string             `json:"partyType,omitempty"`
	PartyID               *uuid.UUID          `json:"partyId,omitempty"`
	Remarks               json.RawMessage     `json:"remarks,omitempty"`
	FromWarehouseID       json.RawMessage     `json:"fromWarehouseId,omitempty"`
	OutsourcedWarehouseID json.RawMessage     `json:"outsourcedWarehouseId,omitempty"`
}

func (s *Server) UpdatePurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedIssueUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外发料单", "remarks"))
		return
	}
	fromWarehouseID, err := optionalUpdate[uuid.UUID](body.FromWarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外发料单", "fromWarehouseId"))
		return
	}
	outsourcedWarehouseID, err := optionalUpdate[uuid.UUID](body.OutsourcedWarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外发料单", "outsourcedWarehouseId"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateIssue(r.Context(), actor, id, outsourced.UpdateIssueInput{
		IssueNo: body.IssueNo, IssueDate: datePointer(body.IssueDate), PartyType: body.PartyType,
		PartyID: body.PartyID, Remarks: remarks, FromWarehouseID: fromWarehouseID,
		OutsourcedWarehouseID: outsourcedWarehouseID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedIssueDTO(item))
}

func (s *Server) AuditPurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "audit")
	if actor == nil {
		return
	}
	item, err := s.OutsourcedFulfillment.AuditIssue(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedIssueDTO(item))
}

func (s *Server) VoidPurchaseOutsourcedIssue(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "void")
	if actor == nil {
		return
	}
	item, err := s.OutsourcedFulfillment.VoidIssue(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedIssueDTO(item))
}

func (s *Server) QueryPurchaseOutsourcedIssueItems(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListIssueItems,
		func(result outsourced.ListResult[outsourced.IssueItem]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedIssueItemDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedIssueItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.IssueItem, error) {
			return s.OutsourcedFulfillment.GetIssueItem(r.Context(), actor, id)
		}, outsourcedIssueItemDTO)
}

type outsourcedIssueItemCreateBody struct {
	IssueID               uuid.UUID  `json:"issueId"`
	Idx                   int64      `json:"idx"`
	Qty                   string     `json:"qty"`
	OrderItemMaterialID   uuid.UUID  `json:"orderItemMaterialId"`
	FromWarehouseID       *uuid.UUID `json:"fromWarehouseId"`
	OutsourcedWarehouseID *uuid.UUID `json:"outsourcedWarehouseId"`
	Remarks               *string    `json:"remarks,omitempty"`
}

func (s *Server) CreatePurchaseOutsourcedIssueItem(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedIssueItemCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "委外发料条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.OutsourcedFulfillment.CreateIssueItem(r.Context(), actor, outsourced.CreateIssueItemInput{
		IssueID: body.IssueID, Idx: body.Idx, Qty: qty, OrderItemMaterialID: body.OrderItemMaterialID,
		FromWarehouseID: body.FromWarehouseID, OutsourcedWarehouseID: body.OutsourcedWarehouseID,
		Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedIssueItemDTO(item))
}

type outsourcedIssueItemUpdateBody struct {
	Idx                   *int64          `json:"idx,omitempty"`
	Qty                   *string         `json:"qty,omitempty"`
	OrderItemMaterialID   *uuid.UUID      `json:"orderItemMaterialId,omitempty"`
	FromWarehouseID       *uuid.UUID      `json:"fromWarehouseId,omitempty"`
	OutsourcedWarehouseID *uuid.UUID      `json:"outsourcedWarehouseId,omitempty"`
	Remarks               json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) UpdatePurchaseOutsourcedIssueItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedIssueItemUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "委外发料条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外发料条目", "remarks"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateIssueItem(r.Context(), actor, id, outsourced.UpdateIssueItemInput{
		Idx: body.Idx, Qty: qty, OrderItemMaterialID: body.OrderItemMaterialID,
		FromWarehouseID: body.FromWarehouseID, OutsourcedWarehouseID: body.OutsourcedWarehouseID,
		Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedIssueItemDTO(item))
}

func (s *Server) DeletePurchaseOutsourcedIssueItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedIssuePermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteIssueItem(r.Context(), actor, id)
	})
}

func (s *Server) QueryPurchaseOutsourcedReceipts(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListReceipts,
		func(result outsourced.ListResult[outsourced.Receipt]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedReceiptDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.Receipt, error) {
			return s.OutsourcedFulfillment.GetReceipt(r.Context(), actor, id)
		}, outsourcedReceiptDTO)
}

func (s *Server) DeletePurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteReceipt(r.Context(), actor, id)
	})
}

type outsourcedReceiptCreateBody struct {
	CompanyID             uuid.UUID           `json:"companyId"`
	ReceiptNo             *string             `json:"receiptNo,omitempty"`
	ReceiptDate           *openapi_types.Date `json:"receiptDate,omitempty"`
	PostingDate           *openapi_types.Date `json:"postingDate,omitempty"`
	PartyType             string              `json:"partyType"`
	PartyID               uuid.UUID           `json:"partyId"`
	Remarks               *string             `json:"remarks,omitempty"`
	WarehouseID           *uuid.UUID          `json:"warehouseId,omitempty"`
	OutsourcedWarehouseID *uuid.UUID          `json:"outsourcedWarehouseId,omitempty"`
	DebitAccountID        *uuid.UUID          `json:"debitAccountId,omitempty"`
	CreditAccountID       *uuid.UUID          `json:"creditAccountId,omitempty"`
}

func (s *Server) CreatePurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedReceiptCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.OutsourcedFulfillment.CreateReceipt(r.Context(), actor, outsourced.CreateReceiptInput{
		CompanyID: body.CompanyID, ReceiptNo: body.ReceiptNo, ReceiptDate: datePointer(body.ReceiptDate),
		PostingDate: datePointer(body.PostingDate), PartyType: body.PartyType, PartyID: body.PartyID,
		Remarks: body.Remarks, WarehouseID: body.WarehouseID,
		OutsourcedWarehouseID: body.OutsourcedWarehouseID, DebitAccountID: body.DebitAccountID,
		CreditAccountID: body.CreditAccountID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedReceiptDTO(item))
}

type outsourcedReceiptUpdateBody struct {
	ReceiptNo             *string             `json:"receiptNo,omitempty"`
	ReceiptDate           *openapi_types.Date `json:"receiptDate,omitempty"`
	PostingDate           json.RawMessage     `json:"postingDate,omitempty"`
	PartyType             *string             `json:"partyType,omitempty"`
	PartyID               *uuid.UUID          `json:"partyId,omitempty"`
	Remarks               json.RawMessage     `json:"remarks,omitempty"`
	WarehouseID           json.RawMessage     `json:"warehouseId,omitempty"`
	OutsourcedWarehouseID json.RawMessage     `json:"outsourcedWarehouseId,omitempty"`
	DebitAccountID        *uuid.UUID          `json:"debitAccountId,omitempty"`
	CreditAccountID       *uuid.UUID          `json:"creditAccountId,omitempty"`
}

func (s *Server) UpdatePurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedReceiptUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	postingDate, err := optionalDateUpdate(body.PostingDate)
	if err != nil {
		s.writeError(w, r, nullableDateError("委外入库单", "postingDate"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外入库单", "remarks"))
		return
	}
	warehouseID, err := optionalUpdate[uuid.UUID](body.WarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外入库单", "warehouseId"))
		return
	}
	outsourcedWarehouseID, err := optionalUpdate[uuid.UUID](body.OutsourcedWarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外入库单", "outsourcedWarehouseId"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateReceipt(r.Context(), actor, id, outsourced.UpdateReceiptInput{
		ReceiptNo: body.ReceiptNo, ReceiptDate: datePointer(body.ReceiptDate),
		PostingDate: postingDate, PartyType: body.PartyType, PartyID: body.PartyID,
		Remarks: remarks, WarehouseID: warehouseID, OutsourcedWarehouseID: outsourcedWarehouseID,
		DebitAccountID: body.DebitAccountID, CreditAccountID: body.CreditAccountID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptDTO(item))
}

func (s *Server) AuditPurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "audit")
	if actor == nil {
		return
	}
	var body struct {
		PostingDate *openapi_types.Date `json:"postingDate,omitempty"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &body); err != nil {
			s.writeError(w, r, invalidJSON(err))
			return
		}
	}
	item, err := s.OutsourcedFulfillment.AuditReceipt(r.Context(), actor, id, outsourced.AuditReceiptInput{
		PostingDate: datePointer(body.PostingDate),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptDTO(item))
}

func (s *Server) VoidPurchaseOutsourcedReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "void")
	if actor == nil {
		return
	}
	item, err := s.OutsourcedFulfillment.VoidReceipt(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptDTO(item))
}

func (s *Server) QueryPurchaseOutsourcedReceiptItems(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListReceiptItems,
		func(result outsourced.ListResult[outsourced.ReceiptItem]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedReceiptItemDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.ReceiptItem, error) {
			return s.OutsourcedFulfillment.GetReceiptItem(r.Context(), actor, id)
		}, outsourcedReceiptItemDTO)
}

type outsourcedReceiptItemCreateBody struct {
	ReceiptID   uuid.UUID  `json:"receiptId"`
	Idx         int64      `json:"idx"`
	Qty         string     `json:"qty"`
	OrderItemID uuid.UUID  `json:"orderItemId"`
	UnitID      *uuid.UUID `json:"unitId,omitempty"`
	WarehouseID *uuid.UUID `json:"warehouseId"`
	Remarks     *string    `json:"remarks,omitempty"`
}

func (s *Server) CreatePurchaseOutsourcedReceiptItem(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedReceiptItemCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "委外入库条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.OutsourcedFulfillment.CreateReceiptItem(r.Context(), actor, outsourced.CreateReceiptItemInput{
		ReceiptID: body.ReceiptID, Idx: body.Idx, Qty: qty, OrderItemID: body.OrderItemID,
		UnitID: body.UnitID, WarehouseID: body.WarehouseID, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedReceiptItemDTO(item))
}

type outsourcedReceiptItemUpdateBody struct {
	Idx         *int64          `json:"idx,omitempty"`
	Qty         *string         `json:"qty,omitempty"`
	OrderItemID *uuid.UUID      `json:"orderItemId,omitempty"`
	UnitID      json.RawMessage `json:"unitId,omitempty"`
	WarehouseID *uuid.UUID      `json:"warehouseId,omitempty"`
	Remarks     json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) UpdatePurchaseOutsourcedReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedReceiptItemUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "委外入库条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	unitID, err := optionalUpdate[uuid.UUID](body.UnitID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外入库条目", "unitId"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外入库条目", "remarks"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateReceiptItem(r.Context(), actor, id, outsourced.UpdateReceiptItemInput{
		Idx: body.Idx, Qty: qty, OrderItemID: body.OrderItemID, UnitID: unitID,
		WarehouseID: body.WarehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptItemDTO(item))
}

func (s *Server) DeletePurchaseOutsourcedReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteReceiptItem(r.Context(), actor, id)
	})
}

type outsourcedReceiptMaterialCreateBody struct {
	ReceiptItemID         uuid.UUID  `json:"receiptItemId"`
	Idx                   int64      `json:"idx"`
	Qty                   string     `json:"qty"`
	OrderItemMaterialID   uuid.UUID  `json:"orderItemMaterialId"`
	OutsourcedWarehouseID *uuid.UUID `json:"outsourcedWarehouseId,omitempty"`
	Remarks               *string    `json:"remarks,omitempty"`
}

type outsourcedReceiptMaterialUpdateBody struct {
	Idx                   *int64          `json:"idx,omitempty"`
	Qty                   *string         `json:"qty,omitempty"`
	OrderItemMaterialID   *uuid.UUID      `json:"orderItemMaterialId,omitempty"`
	OutsourcedWarehouseID json.RawMessage `json:"outsourcedWarehouseId,omitempty"`
	Remarks               json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) QueryPurchaseOutsourcedReceiptItemMaterials(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListReceiptMaterials,
		func(result outsourced.ListResult[outsourced.ReceiptMaterial]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedReceiptMaterialDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedReceiptItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.ReceiptMaterial, error) {
			return s.OutsourcedFulfillment.GetReceiptMaterial(r.Context(), actor, id)
		}, outsourcedReceiptMaterialDTO)
}

func (s *Server) CreatePurchaseOutsourcedReceiptItemMaterial(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedReceiptMaterialCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "委外入库材料扣减行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.OutsourcedFulfillment.CreateReceiptMaterial(r.Context(), actor, outsourced.CreateReceiptMaterialInput{
		ReceiptItemID: body.ReceiptItemID, Idx: body.Idx, Qty: qty,
		OrderItemMaterialID:   body.OrderItemMaterialID,
		OutsourcedWarehouseID: body.OutsourcedWarehouseID, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedReceiptMaterialDTO(item))
}

func (s *Server) UpdatePurchaseOutsourcedReceiptItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedReceiptMaterialUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "委外入库材料扣减行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	warehouseID, err := optionalUpdate[uuid.UUID](body.OutsourcedWarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外入库材料扣减行", "outsourcedWarehouseId"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外入库材料扣减行", "remarks"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateReceiptMaterial(r.Context(), actor, id, outsourced.UpdateReceiptMaterialInput{
		Idx: body.Idx, Qty: qty, OrderItemMaterialID: body.OrderItemMaterialID,
		OutsourcedWarehouseID: warehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptMaterialDTO(item))
}

func (s *Server) DeletePurchaseOutsourcedReceiptItemMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteReceiptMaterial(r.Context(), actor, id)
	})
}

type outsourcedReceiptByproductCreateBody struct {
	ReceiptItemID        uuid.UUID  `json:"receiptItemId"`
	Idx                  int64      `json:"idx"`
	Qty                  string     `json:"qty"`
	OrderItemByproductID uuid.UUID  `json:"orderItemByproductId"`
	WarehouseID          *uuid.UUID `json:"warehouseId,omitempty"`
	Remarks              *string    `json:"remarks,omitempty"`
}

type outsourcedReceiptByproductUpdateBody struct {
	Idx                  *int64          `json:"idx,omitempty"`
	Qty                  *string         `json:"qty,omitempty"`
	OrderItemByproductID *uuid.UUID      `json:"orderItemByproductId,omitempty"`
	WarehouseID          json.RawMessage `json:"warehouseId,omitempty"`
	Remarks              json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) QueryPurchaseOutsourcedReceiptItemByproducts(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	queryListAs(s, w, r, actor, outsourcedListQuery, s.OutsourcedFulfillment.ListReceiptByproducts,
		func(result outsourced.ListResult[outsourced.ReceiptByproduct]) any {
			return countResultsResponse(result.Count, mapItems(result.Results, outsourcedReceiptByproductDTO))
		})
}

func (s *Server) GetPurchaseOutsourcedReceiptItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "read")
	if actor == nil {
		return
	}
	getOutsourced(s, w, r, actor, id,
		func(actor *authz.Actor, id uuid.UUID) (outsourced.ReceiptByproduct, error) {
			return s.OutsourcedFulfillment.GetReceiptByproduct(r.Context(), actor, id)
		}, outsourcedReceiptByproductDTO)
}

func (s *Server) CreatePurchaseOutsourcedReceiptItemByproduct(w http.ResponseWriter, r *http.Request) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "create")
	if actor == nil {
		return
	}
	var body outsourcedReceiptByproductCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "委外入库副产物行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.OutsourcedFulfillment.CreateReceiptByproduct(r.Context(), actor, outsourced.CreateReceiptByproductInput{
		ReceiptItemID: body.ReceiptItemID, Idx: body.Idx, Qty: qty,
		OrderItemByproductID: body.OrderItemByproductID, WarehouseID: body.WarehouseID,
		Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outsourcedReceiptByproductDTO(item))
}

func (s *Server) UpdatePurchaseOutsourcedReceiptItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "update")
	if actor == nil {
		return
	}
	var body outsourcedReceiptByproductUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "委外入库副产物行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	warehouseID, err := optionalUpdate[uuid.UUID](body.WarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("委外入库副产物行", "warehouseId"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("委外入库副产物行", "remarks"))
		return
	}
	item, err := s.OutsourcedFulfillment.UpdateReceiptByproduct(r.Context(), actor, id, outsourced.UpdateReceiptByproductInput{
		Idx: body.Idx, Qty: qty, OrderItemByproductID: body.OrderItemByproductID,
		WarehouseID: warehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outsourcedReceiptByproductDTO(item))
}

func (s *Server) DeletePurchaseOutsourcedReceiptItemByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor := s.authorizeOutsourced(w, r, outsourcedReceiptPermission, "delete")
	if actor == nil {
		return
	}
	deleteOutsourced(s, w, r, actor, id, func(actor *authz.Actor, id uuid.UUID) error {
		return s.OutsourcedFulfillment.DeleteReceiptByproduct(r.Context(), actor, id)
	})
}

func outsourcedIssueDTO(item outsourced.Issue) map[string]any {
	return map[string]any{
		"id": item.ID, "issueNo": item.IssueNo, "issueDate": item.IssueDate.Format(time.DateOnly),
		"partyType": strings.ToUpper(item.PartyType), "partyId": item.PartyID, "remarks": item.Remarks,
		"status": item.Status, "auditedAt": item.AuditedAt, "insertedAt": item.InsertedAt,
		"updatedAt": item.UpdatedAt, "companyId": item.CompanyID,
		"fromWarehouseId": item.FromWarehouseID, "outsourcedWarehouseId": item.OutsourcedWarehouseID,
		"createdById": item.CreatedByID, "auditedById": item.AuditedByID,
	}
}

func outsourcedIssueItemDTO(item outsourced.IssueItem) map[string]any {
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(), "baseQty": item.BaseQty.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "unitName": item.UnitName, "orderNo": item.OrderNo,
		"remarks": item.Remarks, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"issueId": item.IssueID, "companyId": item.CompanyID,
		"orderItemMaterialId": item.OrderItemMaterialID, "materialId": item.MaterialID,
		"unitId": item.UnitID, "fromWarehouseId": item.FromWarehouseID,
		"outsourcedWarehouseId": item.OutsourcedWarehouseID, "issueNo": item.IssueNo,
		"issueDate": item.IssueDate.Format(time.DateOnly), "issueStatus": item.IssueStatus,
		"partyType": strings.ToUpper(item.PartyType), "partyId": item.PartyID,
	}
}

func outsourcedReceiptDTO(item outsourced.Receipt) map[string]any {
	return map[string]any{
		"id": item.ID, "receiptNo": item.ReceiptNo, "receiptDate": item.ReceiptDate.Format(time.DateOnly),
		"postingDate": standardDateOnly(item.PostingDate), "partyType": strings.ToUpper(item.PartyType),
		"partyId": item.PartyID, "remarks": item.Remarks, "status": item.Status,
		"auditedAt": item.AuditedAt, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"companyId": item.CompanyID, "warehouseId": item.WarehouseID,
		"outsourcedWarehouseId": item.OutsourcedWarehouseID, "debitAccountId": item.DebitAccountID,
		"creditAccountId": item.CreditAccountID, "createdById": item.CreatedByID,
		"auditedById": item.AuditedByID,
	}
}

func outsourcedReceiptItemDTO(item outsourced.ReceiptItem) map[string]any {
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(), "baseQty": item.BaseQty.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "customerPartNo": item.CustomerPartNo,
		"unitName": item.UnitName, "orderNo": item.OrderNo, "orderQty": item.OrderQty.String(),
		"orderBaseQty": item.OrderBaseQty.String(), "orderUnitName": item.OrderUnitName,
		"orderPrice": item.OrderPrice.String(), "orderAmount": item.OrderAmount.String(),
		"orderBasePrice": item.OrderBasePrice.String(), "orderBaseAmount": item.OrderBaseAmount.String(),
		"orderTaxRate": item.OrderTaxRate.String(), "orderCurrencyCode": item.OrderCurrencyCode,
		"reconciledQty": item.ReconciledQty.String(), "remarks": item.Remarks,
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt, "receiptId": item.ReceiptID,
		"companyId": item.CompanyID, "orderItemId": item.OrderItemID, "materialId": item.MaterialID,
		"unitId": item.UnitID, "warehouseId": item.WarehouseID, "receiptNo": item.ReceiptNo,
		"receiptDate": item.ReceiptDate.Format(time.DateOnly), "receiptStatus": item.ReceiptStatus,
		"partyType": strings.ToUpper(item.PartyType), "partyId": item.PartyID,
		"remainingReconcilableQty": item.RemainingReconcilableQty.String(),
	}
}

func outsourcedReceiptMaterialDTO(item outsourced.ReceiptMaterial) map[string]any {
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(), "baseQty": item.BaseQty.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "unitName": item.UnitName, "orderNo": item.OrderNo,
		"remarks": item.Remarks, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"receiptItemId": item.ReceiptItemID, "companyId": item.CompanyID,
		"orderItemMaterialId": item.OrderItemMaterialID, "materialId": item.MaterialID,
		"unitId": item.UnitID, "outsourcedWarehouseId": item.OutsourcedWarehouseID,
		"receiptNo": item.ReceiptNo,
	}
}

func outsourcedReceiptByproductDTO(item outsourced.ReceiptByproduct) map[string]any {
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(), "baseQty": item.BaseQty.String(),
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "unitName": item.UnitName, "orderNo": item.OrderNo,
		"remarks": item.Remarks, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"receiptItemId": item.ReceiptItemID, "companyId": item.CompanyID,
		"orderItemByproductId": item.OrderItemByproductID, "materialId": item.MaterialID,
		"unitId": item.UnitID, "warehouseId": item.WarehouseID, "receiptNo": item.ReceiptNo,
	}
}
