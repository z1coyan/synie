package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func standardPermission(side standard.Side, action string) string {
	if side == standard.SideSales {
		return "sales.delivery:" + action
	}
	return "purchase.receipt:" + action
}

// authorizeStandard 是路由门面的唯一鉴权点:鉴权通过后把 actor 显式传给内部实现函数。
func (s *Server) authorizeStandard(
	w http.ResponseWriter, r *http.Request, side standard.Side, action string,
) *authz.Actor {
	actor, err := actorWithPermission(r, standardPermission(side, action))
	if err != nil {
		s.writeError(w, r, err)
		return nil
	}
	return actor
}

func (s *Server) QuerySalesDeliveries(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "read"); actor != nil {
		s.queryStandardHeads(w, r, actor, standard.SideSales)
	}
}
func (s *Server) GetSalesDelivery(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "read"); actor != nil {
		s.getStandardHead(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) CreateSalesDelivery(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "create"); actor != nil {
		s.createStandardHead(w, r, actor, standard.SideSales)
	}
}
func (s *Server) UpdateSalesDelivery(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "update"); actor != nil {
		s.updateStandardHead(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) DeleteSalesDelivery(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "delete"); actor != nil {
		s.deleteStandardHead(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) AuditSalesDelivery(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "audit"); actor != nil {
		s.auditStandardHead(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) VoidSalesDelivery(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "void"); actor != nil {
		s.voidStandardHead(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) QuerySalesDeliveryItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "read"); actor != nil {
		s.queryStandardItems(w, r, actor, standard.SideSales)
	}
}
func (s *Server) GetSalesDeliveryItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "read"); actor != nil {
		s.getStandardItem(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) CreateSalesDeliveryItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "create"); actor != nil {
		s.createStandardItem(w, r, actor, standard.SideSales)
	}
}
func (s *Server) UpdateSalesDeliveryItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "update"); actor != nil {
		s.updateStandardItem(w, r, actor, standard.SideSales, id)
	}
}
func (s *Server) DeleteSalesDeliveryItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SideSales, "delete"); actor != nil {
		s.deleteStandardItem(w, r, actor, standard.SideSales, id)
	}
}

func (s *Server) QueryPurchaseReceipts(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "read"); actor != nil {
		s.queryStandardHeads(w, r, actor, standard.SidePurchase)
	}
}
func (s *Server) GetPurchaseReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "read"); actor != nil {
		s.getStandardHead(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseReceipt(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "create"); actor != nil {
		s.createStandardHead(w, r, actor, standard.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "update"); actor != nil {
		s.updateStandardHead(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "delete"); actor != nil {
		s.deleteStandardHead(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) AuditPurchaseReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "audit"); actor != nil {
		s.auditStandardHead(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) VoidPurchaseReceipt(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "void"); actor != nil {
		s.voidStandardHead(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) QueryPurchaseReceiptItems(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "read"); actor != nil {
		s.queryStandardItems(w, r, actor, standard.SidePurchase)
	}
}
func (s *Server) GetPurchaseReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "read"); actor != nil {
		s.getStandardItem(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) CreatePurchaseReceiptItem(w http.ResponseWriter, r *http.Request) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "create"); actor != nil {
		s.createStandardItem(w, r, actor, standard.SidePurchase)
	}
}
func (s *Server) UpdatePurchaseReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "update"); actor != nil {
		s.updateStandardItem(w, r, actor, standard.SidePurchase, id)
	}
}
func (s *Server) DeletePurchaseReceiptItem(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	if actor := s.authorizeStandard(w, r, standard.SidePurchase, "delete"); actor != nil {
		s.deleteStandardItem(w, r, actor, standard.SidePurchase, id)
	}
}

func (s *Server) GetSalesCompanyAccountDefaultsByCompany(
	w http.ResponseWriter, r *http.Request, companyID uuid.UUID,
) {
	actor, err := actorWithPermission(r, "sales.setting:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.CompanyAccountDefaults.GetByCompany(r.Context(), actor, companyID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, companyAccountDefaultDTO(result))
}

func standardListQuery(body listBody) standard.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return standard.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) queryStandardHeads(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side,
) {
	queryListAs(s, w, r, actor, standardListQuery,
		func(ctx context.Context, actor *authz.Actor, query standard.ListQuery) (standard.HeadListResult, error) {
			return s.StandardFulfillment.ListHeads(ctx, actor, side, query)
		},
		func(result standard.HeadListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results,
				func(item standard.Head) map[string]any { return standardHeadDTO(item, side) }))
		})
}

func (s *Server) getStandardHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	item, err := s.StandardFulfillment.GetHead(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardHeadDTO(item, side))
}

type standardHeadCreateBody struct {
	CompanyID       uuid.UUID           `json:"companyId"`
	DeliveryNo      *string             `json:"deliveryNo,omitempty"`
	ReceiptNo       *string             `json:"receiptNo,omitempty"`
	DeliveryDate    *openapi_types.Date `json:"deliveryDate,omitempty"`
	ReceiptDate     *openapi_types.Date `json:"receiptDate,omitempty"`
	PostingDate     *openapi_types.Date `json:"postingDate,omitempty"`
	PartyType       string              `json:"partyType"`
	PartyID         uuid.UUID           `json:"partyId"`
	Remarks         *string             `json:"remarks,omitempty"`
	WarehouseID     *uuid.UUID          `json:"warehouseId,omitempty"`
	DebitAccountID  uuid.UUID           `json:"debitAccountId"`
	CreditAccountID uuid.UUID           `json:"creditAccountId"`
}

func (s *Server) createStandardHead(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side) {
	var body standardHeadCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	number, documentDate := body.DeliveryNo, body.DeliveryDate
	if side == standard.SidePurchase {
		number, documentDate = body.ReceiptNo, body.ReceiptDate
	}
	item, err := s.StandardFulfillment.CreateHead(r.Context(), actor, side, standard.CreateHeadInput{
		CompanyID: body.CompanyID, No: number, DocumentDate: datePointer(documentDate),
		PostingDate: datePointer(body.PostingDate), PartyType: body.PartyType, PartyID: body.PartyID,
		Remarks: body.Remarks, WarehouseID: body.WarehouseID, DebitAccountID: body.DebitAccountID,
		CreditAccountID: body.CreditAccountID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, standardHeadDTO(item, side))
}

type standardHeadUpdateBody struct {
	DeliveryNo      *string             `json:"deliveryNo,omitempty"`
	ReceiptNo       *string             `json:"receiptNo,omitempty"`
	DeliveryDate    *openapi_types.Date `json:"deliveryDate,omitempty"`
	ReceiptDate     *openapi_types.Date `json:"receiptDate,omitempty"`
	PostingDate     json.RawMessage     `json:"postingDate,omitempty"`
	PartyType       *string             `json:"partyType,omitempty"`
	PartyID         *uuid.UUID          `json:"partyId,omitempty"`
	Remarks         json.RawMessage     `json:"remarks,omitempty"`
	WarehouseID     json.RawMessage     `json:"warehouseId,omitempty"`
	DebitAccountID  *uuid.UUID          `json:"debitAccountId,omitempty"`
	CreditAccountID *uuid.UUID          `json:"creditAccountId,omitempty"`
}

func (s *Server) updateStandardHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	var body standardHeadUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	number, documentDate := body.DeliveryNo, body.DeliveryDate
	if side == standard.SidePurchase {
		number, documentDate = body.ReceiptNo, body.ReceiptDate
	}
	postingDate, err := nullableDateUpdate(body.PostingDate)
	if err != nil {
		s.writeError(w, r, nullableDateError("履约单", "postingDate"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("履约单", "remarks"))
		return
	}
	warehouseID, err := nullableUUIDUpdate(body.WarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("履约单", "warehouseId"))
		return
	}
	item, err := s.StandardFulfillment.UpdateHead(r.Context(), actor, side, id, standard.UpdateHeadInput{
		No: number, DocumentDate: datePointer(documentDate), PostingDate: postingDate,
		PartyType: body.PartyType, PartyID: body.PartyID, Remarks: remarks,
		WarehouseID: warehouseID, DebitAccountID: body.DebitAccountID,
		CreditAccountID: body.CreditAccountID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardHeadDTO(item, side))
}

func (s *Server) deleteStandardHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	if err := s.StandardFulfillment.DeleteHead(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) auditStandardHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	var body struct {
		PostingDate *openapi_types.Date `json:"postingDate,omitempty"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &body); err != nil {
			s.writeError(w, r, invalidJSON(err))
			return
		}
	}
	item, err := s.StandardFulfillment.Audit(
		r.Context(), actor, side, id, datePointer(body.PostingDate),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardHeadDTO(item, side))
}

func (s *Server) voidStandardHead(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	item, err := s.StandardFulfillment.Void(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardHeadDTO(item, side))
}

func (s *Server) queryStandardItems(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side,
) {
	queryListAs(s, w, r, actor, standardListQuery,
		func(ctx context.Context, actor *authz.Actor, query standard.ListQuery) (standard.ItemListResult, error) {
			return s.StandardFulfillment.ListItems(ctx, actor, side, query)
		},
		func(result standard.ItemListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results,
				func(item standard.Item) map[string]any { return standardItemDTO(item, side) }))
		})
}

func (s *Server) getStandardItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	item, err := s.StandardFulfillment.GetItem(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardItemDTO(item, side))
}

type standardItemCreateBody struct {
	DeliveryID  uuid.UUID  `json:"deliveryId,omitempty"`
	ReceiptID   uuid.UUID  `json:"receiptId,omitempty"`
	Idx         int64      `json:"idx"`
	Qty         string     `json:"qty"`
	OrderItemID uuid.UUID  `json:"orderItemId"`
	UnitID      *uuid.UUID `json:"unitId,omitempty"`
	WarehouseID uuid.UUID  `json:"warehouseId"`
	Remarks     *string    `json:"remarks,omitempty"`
}

func (s *Server) createStandardItem(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side) {
	var body standardItemCreateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "履约条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	headID := body.DeliveryID
	if side == standard.SidePurchase {
		headID = body.ReceiptID
	}
	item, err := s.StandardFulfillment.CreateItem(r.Context(), actor, side, standard.CreateItemInput{
		HeadID: headID, Idx: body.Idx, Qty: qty, OrderItemID: body.OrderItemID,
		UnitID: body.UnitID, WarehouseID: body.WarehouseID, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, standardItemDTO(item, side))
}

type standardItemUpdateBody struct {
	Idx         *int64          `json:"idx,omitempty"`
	Qty         *string         `json:"qty,omitempty"`
	OrderItemID *uuid.UUID      `json:"orderItemId,omitempty"`
	UnitID      json.RawMessage `json:"unitId,omitempty"`
	WarehouseID *uuid.UUID      `json:"warehouseId,omitempty"`
	Remarks     json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) updateStandardItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	var body standardItemUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "履约条目", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	unitID, err := nullableUUIDUpdate(body.UnitID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("履约条目", "unitId"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("履约条目", "remarks"))
		return
	}
	item, err := s.StandardFulfillment.UpdateItem(r.Context(), actor, side, id, standard.UpdateItemInput{
		Idx: body.Idx, Qty: qty, OrderItemID: body.OrderItemID, UnitID: unitID,
		WarehouseID: body.WarehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, standardItemDTO(item, side))
}

func (s *Server) deleteStandardItem(
	w http.ResponseWriter, r *http.Request, actor *authz.Actor, side standard.Side, id uuid.UUID,
) {
	if err := s.StandardFulfillment.DeleteItem(r.Context(), actor, side, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func standardHeadDTO(item standard.Head, side standard.Side) map[string]any {
	numberKey, dateKey := "deliveryNo", "deliveryDate"
	if side == standard.SidePurchase {
		numberKey, dateKey = "receiptNo", "receiptDate"
	}
	return map[string]any{
		"id": item.ID, numberKey: item.No, dateKey: item.DocumentDate.Format(time.DateOnly),
		"postingDate": standardDateOnly(item.PostingDate), "partyType": strings.ToUpper(item.PartyType),
		"partyId": item.PartyID, "remarks": item.Remarks, "status": item.Status,
		"auditedAt": item.AuditedAt, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"companyId": item.CompanyID, "warehouseId": item.WarehouseID,
		"debitAccountId": item.DebitAccountID, "creditAccountId": item.CreditAccountID,
		"createdById": item.CreatedByID, "auditedById": item.AuditedByID,
	}
}

func standardItemDTO(item standard.Item, side standard.Side) map[string]any {
	parentIDKey, parentNoKey, parentDateKey, parentStatusKey :=
		"deliveryId", "deliveryNo", "deliveryDate", "deliveryStatus"
	if side == standard.SidePurchase {
		parentIDKey, parentNoKey, parentDateKey, parentStatusKey =
			"receiptId", "receiptNo", "receiptDate", "receiptStatus"
	}
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
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt, parentIDKey: item.HeadID,
		"companyId": item.CompanyID, "orderItemId": item.OrderItemID, "materialId": item.MaterialID,
		"unitId": item.UnitID, "warehouseId": item.WarehouseID, parentNoKey: item.HeadNo,
		parentDateKey: item.HeadDate.Format(time.DateOnly), parentStatusKey: item.HeadStatus,
		"partyType": strings.ToUpper(item.PartyType), "partyId": item.PartyID,
		"remainingReconcilableQty": item.RemainingReconcilableQty.String(),
	}
}

func standardDateOnly(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.Format(time.DateOnly)
}
