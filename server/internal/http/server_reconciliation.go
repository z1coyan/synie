package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func reconciliationPermission(side reconciliation.Side, action string) string {
	if side == reconciliation.SideSales {
		return "sales.reconciliation:" + action
	}
	return "purchase.reconciliation:" + action
}

// authorizeReconciliation 是路由门面的唯一鉴权点:鉴权通过后把 actor 显式传给内部实现函数。
func (s *Server) authorizeReconciliation(
	w http.ResponseWriter, r *http.Request, side reconciliation.Side, action string,
) *authz.Actor {
	actor, err := actorWithPermission(r, reconciliationPermission(side, action))
	if err != nil {
		s.writeError(w, r, err)
		return nil
	}
	return actor
}

func (s *Server) QuerySalesReconciliations(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "read"); actor != nil {
		s.queryReconciliationHeads(w, r, actor, reconciliation.SideSales)
	}
}

func (s *Server) GetSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "read"); actor != nil {
		s.getReconciliationHead(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) CreateSalesReconciliation(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "create"); actor != nil {
		s.createReconciliationHead(w, r, actor, reconciliation.SideSales)
	}
}

func (s *Server) UpdateSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "update"); actor != nil {
		s.updateReconciliationHead(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) DeleteSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "delete"); actor != nil {
		s.deleteReconciliationHead(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) ConfirmSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "confirm"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SideSales, id, "confirm")
	}
}

func (s *Server) UnconfirmSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "unconfirm"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SideSales, id, "unconfirm")
	}
}

func (s *Server) AuditSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "audit"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SideSales, id, "audit")
	}
}

func (s *Server) VoidSalesReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "void"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SideSales, id, "void")
	}
}

func (s *Server) QuerySalesReconciliationItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "read"); actor != nil {
		s.queryReconciliationItems(w, r, actor, reconciliation.SideSales)
	}
}

func (s *Server) GetSalesReconciliationItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "read"); actor != nil {
		s.getReconciliationItem(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) CreateSalesReconciliationItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "create"); actor != nil {
		s.createReconciliationItem(w, r, actor, reconciliation.SideSales)
	}
}

func (s *Server) UpdateSalesReconciliationItem(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "update"); actor != nil {
		s.updateReconciliationItem(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) DeleteSalesReconciliationItem(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SideSales, "delete"); actor != nil {
		s.deleteReconciliationItem(w, r, actor, reconciliation.SideSales, id)
	}
}

func (s *Server) QueryPurchaseReconciliations(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "read"); actor != nil {
		s.queryReconciliationHeads(w, r, actor, reconciliation.SidePurchase)
	}
}

func (s *Server) GetPurchaseReconciliation(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "read"); actor != nil {
		s.getReconciliationHead(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseReconciliation(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "create"); actor != nil {
		s.createReconciliationHead(w, r, actor, reconciliation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "update"); actor != nil {
		s.updateReconciliationHead(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "delete"); actor != nil {
		s.deleteReconciliationHead(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func (s *Server) ConfirmPurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "confirm"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SidePurchase, id, "confirm")
	}
}

func (s *Server) UnconfirmPurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "unconfirm"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SidePurchase, id, "unconfirm")
	}
}

func (s *Server) AuditPurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "audit"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SidePurchase, id, "audit")
	}
}

func (s *Server) VoidPurchaseReconciliation(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "void"); actor != nil {
		s.reconciliationAction(w, r, actor, reconciliation.SidePurchase, id, "void")
	}
}

func (s *Server) QueryPurchaseReconciliationItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "read"); actor != nil {
		s.queryReconciliationItems(w, r, actor, reconciliation.SidePurchase)
	}
}

func (s *Server) GetPurchaseReconciliationItem(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "read"); actor != nil {
		s.getReconciliationItem(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func (s *Server) CreatePurchaseReconciliationItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "create"); actor != nil {
		s.createReconciliationItem(w, r, actor, reconciliation.SidePurchase)
	}
}

func (s *Server) UpdatePurchaseReconciliationItem(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "update"); actor != nil {
		s.updateReconciliationItem(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func (s *Server) DeletePurchaseReconciliationItem(
	w http.ResponseWriter, r *http.Request, id uuid.UUID,
) {
	if actor := s.authorizeReconciliation(w, r, reconciliation.SidePurchase, "delete"); actor != nil {
		s.deleteReconciliationItem(w, r, actor, reconciliation.SidePurchase, id)
	}
}

func reconciliationListQuery(body listBody) reconciliation.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return reconciliation.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) queryReconciliationHeads(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side,
) {
	queryListAs(s, w, r, actor, reconciliationListQuery,
		func(ctx context.Context, actor *authz.Actor, query reconciliation.ListQuery) (reconciliation.HeadList, error) {
			return s.Reconciliations.ListHeads(ctx, actor, side, query)
		},
		func(result reconciliation.HeadList) any {
			return countResultsResponse(result.Count, mapItems(result.Results, reconciliationHeadDTO))
		})
}

func (s *Server) getReconciliationHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	item, err := s.Reconciliations.GetHead(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, reconciliationHeadDTO(item))
}

type reconciliationHeadCreateBody struct {
	CompanyID          uuid.UUID  `json:"companyId"`
	ReconciliationNo   *string    `json:"reconciliationNo,omitempty"`
	ReconciliationType string     `json:"reconciliationType"`
	PartyType          string     `json:"partyType"`
	PartyID            uuid.UUID  `json:"partyId"`
	DebitAccountID     *uuid.UUID `json:"debitAccountId,omitempty"`
	CreditAccountID    *uuid.UUID `json:"creditAccountId,omitempty"`
	Remarks            *string    `json:"remarks,omitempty"`
}

func (s *Server) createReconciliationHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side,
) {
	var body reconciliationHeadCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.Reconciliations.CreateHead(
		r.Context(), actor, side, reconciliation.CreateHeadInput{
			CompanyID: body.CompanyID, No: body.ReconciliationNo,
			Kind:      reconciliation.Kind(strings.ToLower(body.ReconciliationType)),
			PartyType: body.PartyType, PartyID: body.PartyID,
			DebitAccountID:  reconciliationUUID(body.DebitAccountID),
			CreditAccountID: reconciliationUUID(body.CreditAccountID),
			Remarks:         body.Remarks,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, reconciliationHeadDTO(item))
}

func reconciliationUUID(value *uuid.UUID) uuid.UUID {
	if value == nil {
		return uuid.Nil
	}
	return *value
}

type reconciliationHeadUpdateBody struct {
	ReconciliationNo   *string         `json:"reconciliationNo,omitempty"`
	ReconciliationType *string         `json:"reconciliationType,omitempty"`
	PartyType          *string         `json:"partyType,omitempty"`
	PartyID            *uuid.UUID      `json:"partyId,omitempty"`
	DebitAccountID     *uuid.UUID      `json:"debitAccountId,omitempty"`
	CreditAccountID    *uuid.UUID      `json:"creditAccountId,omitempty"`
	Remarks            json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) updateReconciliationHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	var body reconciliationHeadUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("对账单", "remarks"))
		return
	}
	var kind *reconciliation.Kind
	if body.ReconciliationType != nil {
		value := reconciliation.Kind(strings.ToLower(*body.ReconciliationType))
		kind = &value
	}
	item, err := s.Reconciliations.UpdateHead(
		r.Context(), actor, side, id, reconciliation.UpdateHeadInput{
			No: body.ReconciliationNo, Kind: kind, PartyType: body.PartyType,
			PartyID: body.PartyID, DebitAccountID: body.DebitAccountID,
			CreditAccountID: body.CreditAccountID, Remarks: remarks,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, reconciliationHeadDTO(item))
}

func (s *Server) deleteReconciliationHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	if err := s.Reconciliations.DeleteHead(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) reconciliationAction(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID, action string,
) {
	var item reconciliation.Head
	var err error
	switch action {
	case "confirm":
		item, err = s.Reconciliations.Confirm(r.Context(), actor, side, id)
	case "unconfirm":
		item, err = s.Reconciliations.Unconfirm(r.Context(), actor, side, id)
	case "audit":
		var body struct {
			PostingDate *openapi_types.Date `json:"postingDate,omitempty"`
		}
		if r.ContentLength != 0 {
			if decodeErr := decodeJSON(w, r, &body); decodeErr != nil {
				s.writeError(w, r, invalidJSON(decodeErr))
				return
			}
		}
		item, err = s.Reconciliations.Audit(
			r.Context(), actor, side, id,
			reconciliation.AuditInput{PostingDate: datePointer(body.PostingDate)},
		)
	case "void":
		item, err = s.Reconciliations.Void(r.Context(), actor, side, id)
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, reconciliationHeadDTO(item))
}

func (s *Server) queryReconciliationItems(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side,
) {
	queryListAs(s, w, r, actor, reconciliationListQuery,
		func(ctx context.Context, actor *authz.Actor, query reconciliation.ListQuery) (reconciliation.ItemList, error) {
			return s.Reconciliations.ListItems(ctx, actor, side, query)
		},
		func(result reconciliation.ItemList) any {
			return countResultsResponse(result.Count, mapItems(result.Results,
				func(item reconciliation.Item) map[string]any { return reconciliationItemDTO(item, side) }))
		})
}

func (s *Server) getReconciliationItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	item, err := s.Reconciliations.GetItem(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, reconciliationItemDTO(item, side))
}

type reconciliationItemCreateBody struct {
	ReconciliationID        uuid.UUID  `json:"reconciliationId"`
	Idx                     int64      `json:"idx"`
	Qty                     string     `json:"qty"`
	DeliveryItemID          *uuid.UUID `json:"deliveryItemId,omitempty"`
	ReceiptItemID           *uuid.UUID `json:"receiptItemId,omitempty"`
	OutsourcedReceiptItemID *uuid.UUID `json:"outsourcedReceiptItemId,omitempty"`
	Remarks                 *string    `json:"remarks,omitempty"`
}

func (s *Server) createReconciliationItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side,
) {
	var body reconciliationItemCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "对账条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Reconciliations.CreateItem(
		r.Context(), actor, side, reconciliation.CreateItemInput{
			ReconciliationID: body.ReconciliationID, Idx: body.Idx, Qty: qty,
			DeliveryItemID: body.DeliveryItemID, ReceiptItemID: body.ReceiptItemID,
			OutsourcedReceiptItemID: body.OutsourcedReceiptItemID, Remarks: body.Remarks,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, reconciliationItemDTO(item, side))
}

type reconciliationItemUpdateBody struct {
	Idx                     *int64          `json:"idx,omitempty"`
	Qty                     *string         `json:"qty,omitempty"`
	DeliveryItemID          json.RawMessage `json:"deliveryItemId,omitempty"`
	ReceiptItemID           json.RawMessage `json:"receiptItemId,omitempty"`
	OutsourcedReceiptItemID json.RawMessage `json:"outsourcedReceiptItemId,omitempty"`
	Remarks                 json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) updateReconciliationItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	var body reconciliationItemUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "对账条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	deliveryID, err := nullableUUIDUpdate(body.DeliveryItemID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("对账条目", "deliveryItemId"))
		return
	}
	receiptID, err := nullableUUIDUpdate(body.ReceiptItemID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("对账条目", "receiptItemId"))
		return
	}
	outsourcedID, err := nullableUUIDUpdate(body.OutsourcedReceiptItemID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("对账条目", "outsourcedReceiptItemId"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("对账条目", "remarks"))
		return
	}
	item, err := s.Reconciliations.UpdateItem(
		r.Context(), actor, side, id, reconciliation.UpdateItemInput{
			Idx: body.Idx, Qty: qty, DeliveryItemID: deliveryID,
			ReceiptItemID: receiptID, OutsourcedReceiptItemID: outsourcedID,
			Remarks: remarks,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, reconciliationItemDTO(item, side))
}

func (s *Server) deleteReconciliationItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side reconciliation.Side, id uuid.UUID,
) {
	if err := s.Reconciliations.DeleteItem(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func reconciliationHeadDTO(item reconciliation.Head) map[string]any {
	return map[string]any{
		"id": item.ID, "reconciliationNo": item.No,
		"reconciliationType": strings.ToUpper(string(item.Kind)),
		"partyType":          strings.ToUpper(item.PartyType), "partyId": item.PartyID,
		"postingDate": standardDateOnly(item.PostingDate), "remarks": item.Remarks,
		"status": strings.ToUpper(string(item.Status)), "insertedAt": item.InsertedAt,
		"updatedAt": item.UpdatedAt, "companyId": item.CompanyID,
		"debitAccountId": item.DebitAccountID, "creditAccountId": item.CreditAccountID,
		"createdById": item.CreatedByID, "grossTotal": item.GrossTotal.String(),
		"baseGrossTotal": item.BaseGrossTotal.String(),
	}
}

func reconciliationItemDTO(
	item reconciliation.Item, side reconciliation.Side,
) map[string]any {
	numberKey, dateKey := "receiptNo", "receiptDate"
	if side == reconciliation.SideSales {
		numberKey, dateKey = "deliveryNo", "deliveryDate"
	}
	return map[string]any{
		"id": item.ID, "idx": item.Idx, "qty": item.Qty.String(),
		"baseQty": item.BaseQty.String(), "amount": item.Amount.String(),
		"baseAmount": item.BaseAmount.String(), "remarks": item.Remarks,
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"reconciliationId": item.ReconciliationID, "companyId": item.CompanyID,
		"deliveryItemId": item.DeliveryItemID, "receiptItemId": item.ReceiptItemID,
		"outsourcedReceiptItemId": item.OutsourcedReceiptItemID,
		"reconciliationNo":        item.ReconciliationNo,
		"reconciliationStatus":    strings.ToUpper(string(item.ReconciliationStatus)),
		numberKey:                 item.SourceNo, dateKey: item.SourceDate.Format(time.DateOnly),
		"materialName": item.MaterialName, "unitName": item.UnitName,
		"orderCurrencyCode": item.OrderCurrencyCode,
	}
}
