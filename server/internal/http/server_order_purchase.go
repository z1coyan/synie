package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/http/gen"
)

func (s *Server) queryOrderMaterials(w http.ResponseWriter, r *http.Request) {
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	actor, _ := requireActor(r)
	result, err := s.orders.ListMaterials(r.Context(), actor, orderListQuery(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = orderMaterialDTO(item)
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"count": result.Count, "results": items})
}

func (s *Server) getOrderMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor, _ := requireActor(r)
	item, err := s.orders.GetMaterial(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderMaterialDTO(item))
}

func (s *Server) createOrderMaterial(w http.ResponseWriter, r *http.Request) {
	var body gen.OrderItemMaterialCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	quantity, err := decimalInput(body.Quantity, "委外发料清单", "quantity")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	actor, _ := requireActor(r)
	item, err := s.orders.CreateMaterial(r.Context(), actor, order.CreateMaterialInput{
		OrderItemID: body.OrderItemId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderMaterialDTO(item))
}

func (s *Server) updateOrderMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	input, ok := s.decodeOrderMaterialUpdate(w, r, "委外发料清单")
	if !ok {
		return
	}
	actor, _ := requireActor(r)
	item, err := s.orders.UpdateMaterial(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderMaterialDTO(item))
}

func (s *Server) deleteOrderMaterial(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor, _ := requireActor(r)
	if err := s.orders.DeleteMaterial(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) queryOrderByproducts(w http.ResponseWriter, r *http.Request) {
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	actor, _ := requireActor(r)
	result, err := s.orders.ListByproducts(r.Context(), actor, orderListQuery(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]map[string]any, len(result.Results))
	for i, item := range result.Results {
		items[i] = orderByproductDTO(item)
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"count": result.Count, "results": items})
}

func (s *Server) getOrderByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor, _ := requireActor(r)
	item, err := s.orders.GetByproduct(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderByproductDTO(item))
}

func (s *Server) createOrderByproduct(w http.ResponseWriter, r *http.Request) {
	var body gen.OrderItemByproductCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	quantity, err := decimalInput(body.Quantity, "委外副产物清单", "quantity")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	actor, _ := requireActor(r)
	item, err := s.orders.CreateByproduct(r.Context(), actor, order.CreateByproductInput{
		OrderItemID: body.OrderItemId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderByproductDTO(item))
}

func (s *Server) updateOrderByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	input, ok := s.decodeOrderMaterialUpdate(w, r, "委外副产物清单")
	if !ok {
		return
	}
	actor, _ := requireActor(r)
	item, err := s.orders.UpdateByproduct(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderByproductDTO(item))
}

func (s *Server) deleteOrderByproduct(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	actor, _ := requireActor(r)
	if err := s.orders.DeleteByproduct(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) decodeOrderMaterialUpdate(
	w http.ResponseWriter, r *http.Request, label string,
) (order.UpdateMaterialInput, bool) {
	var body struct {
		MaterialID *uuid.UUID      `json:"materialId,omitempty"`
		UnitID     *uuid.UUID      `json:"unitId,omitempty"`
		Quantity   *string         `json:"quantity,omitempty"`
		Remarks    json.RawMessage `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return order.UpdateMaterialInput{}, false
	}
	quantity, err := optionalDecimalInput(body.Quantity, label, "quantity")
	if err != nil {
		s.writeError(w, r, err)
		return order.UpdateMaterialInput{}, false
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError(label, "remarks"))
		return order.UpdateMaterialInput{}, false
	}
	return order.UpdateMaterialInput{
		MaterialID: body.MaterialID, UnitID: body.UnitID, Quantity: quantity, Remarks: remarks,
	}, true
}

func (s *Server) queryOrderDemandPool(w http.ResponseWriter, r *http.Request) {
	var body gen.OrderDemandLineQuery
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit := 200
	if body.Limit != nil {
		limit = int(*body.Limit)
	}
	actor, _ := requireActor(r)
	items, err := s.orders.ListDemandPool(r.Context(), actor, order.DemandPoolQuery{
		CompanyID: body.CompanyId, IsOutsourced: body.IsOutsourced, Limit: limit,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	results := make([]map[string]any, len(items))
	for i, item := range items {
		results[i] = map[string]any{
			"id": item.ID, "demandId": item.DemandID, "demandNo": item.DemandNo,
			"idx": item.Idx, "needDate": dateOnly(item.NeedDate), "companyId": item.CompanyID,
			"materialId": item.MaterialID, "unitId": item.UnitID,
			"materialCode": item.MaterialCode, "materialName": item.MaterialName,
			"materialSpec": item.MaterialSpec, "unitName": item.UnitName,
			"baseQty": item.BaseQty.String(), "orderedQty": item.OrderedQty.String(),
			"remainingBaseQty": item.RemainingBaseQty.String(), "suggestedQty": item.SuggestedQty.String(),
		}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) previewOrderBOM(w http.ResponseWriter, r *http.Request) {
	var body gen.OrderBomExpandRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "委外 BOM 预览", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	actor, _ := requireActor(r)
	preview, err := s.orders.PreviewBOM(r.Context(), actor, body.BomId, qty)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"materials":  bomPreviewDTO(preview.Materials),
		"byproducts": bomPreviewDTO(preview.Byproducts),
	})
}

func (s *Server) getOrderHistory(w http.ResponseWriter, r *http.Request, side order.Side, id uuid.UUID) {
	actor, _ := requireActor(r)
	items, err := s.orders.ListOrderFlow(r.Context(), actor, side, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	results := make([]map[string]any, len(items))
	for i, item := range items {
		results[i] = map[string]any{
			"flowType": item.FlowType, "voucherNo": item.DocumentNo,
			"voucherDate": item.DocumentDate.Format("2006-01-02"), "status": item.Status,
			"companyId": item.CompanyID, "orderId": item.OrderID, "orderItemId": item.OrderItemID,
			"materialCode": item.MaterialCode, "materialName": item.MaterialName,
			"materialSpec": item.MaterialSpec, "customerPartNo": item.CustomerPartNo,
			"unitName": item.UnitName, "qty": item.Quantity.String(),
		}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func orderMaterialDTO(item order.Material) map[string]any {
	return map[string]any{
		"id": item.ID, "quantity": item.Quantity.String(), "issuedQty": item.IssuedQty.String(),
		"remarks": item.Remarks, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
		"orderItemId": item.OrderItemID, "companyId": item.CompanyID, "materialId": item.MaterialID,
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "unitId": item.UnitID, "unitName": item.UnitName,
		"orderNo": item.OrderNo, "orderStatus": item.OrderStatus,
		"orderIsOutsourced": item.OrderIsOutsourced, "partyType": item.PartyType,
		"partyId": item.PartyID, "remainingIssueQty": item.RemainingIssueQty.String(),
	}
}

func orderByproductDTO(item order.Byproduct) map[string]any {
	return map[string]any{
		"id": item.ID, "quantity": item.Quantity.String(), "remarks": item.Remarks,
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt, "orderItemId": item.OrderItemID,
		"companyId": item.CompanyID, "materialId": item.MaterialID,
		"materialCode": item.MaterialCode, "materialName": item.MaterialName,
		"materialSpec": item.MaterialSpec, "unitId": item.UnitID, "unitName": item.UnitName,
	}
}

func bomPreviewDTO(items []order.BOMPreviewLine) []map[string]any {
	result := make([]map[string]any, len(items))
	for i, item := range items {
		result[i] = map[string]any{
			"materialId": item.MaterialID, "materialCode": item.MaterialCode,
			"materialName": item.MaterialName, "unitId": item.UnitID, "unitName": item.UnitName,
			"quantity": item.Quantity.String(), "remarks": item.Remarks,
		}
	}
	return result
}
