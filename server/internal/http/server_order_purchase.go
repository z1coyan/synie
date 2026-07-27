package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Server) queryOrderMaterials(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
	queryListAs(s, w, r, actor, orderListQuery,
		func(ctx context.Context, actor *authz.Actor, query order.ListQuery) (order.MaterialListResult, error) {
			return s.Orders.ListMaterials(ctx, actor, query)
		},
		func(result order.MaterialListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results, orderMaterialDTO))
		})
}

func (s *Server) getOrderMaterial(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	item, err := s.Orders.GetMaterial(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderMaterialDTO(item))
}

func (s *Server) createOrderMaterial(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
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
	item, err := s.Orders.CreateMaterial(r.Context(), actor, order.CreateMaterialInput{
		OrderItemID: body.OrderItemId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderMaterialDTO(item))
}

func (s *Server) updateOrderMaterial(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	input, ok := s.decodeOrderMaterialUpdate(w, r, "委外发料清单")
	if !ok {
		return
	}
	item, err := s.Orders.UpdateMaterial(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderMaterialDTO(item))
}

func (s *Server) deleteOrderMaterial(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	if err := s.Orders.DeleteMaterial(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) queryOrderByproducts(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
	queryListAs(s, w, r, actor, orderListQuery,
		func(ctx context.Context, actor *authz.Actor, query order.ListQuery) (order.ByproductListResult, error) {
			return s.Orders.ListByproducts(ctx, actor, query)
		},
		func(result order.ByproductListResult) any {
			return countResultsResponse(result.Count, mapItems(result.Results, orderByproductDTO))
		})
}

func (s *Server) getOrderByproduct(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	item, err := s.Orders.GetByproduct(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderByproductDTO(item))
}

func (s *Server) createOrderByproduct(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
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
	item, err := s.Orders.CreateByproduct(r.Context(), actor, order.CreateByproductInput{
		OrderItemID: body.OrderItemId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, orderByproductDTO(item))
}

func (s *Server) updateOrderByproduct(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	input, ok := s.decodeOrderMaterialUpdate(w, r, "委外副产物清单")
	if !ok {
		return
	}
	item, err := s.Orders.UpdateByproduct(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderByproductDTO(item))
}

func (s *Server) deleteOrderByproduct(w http.ResponseWriter, r *http.Request, actor *authz.Actor, id uuid.UUID) {
	if err := s.Orders.DeleteByproduct(r.Context(), actor, id); err != nil {
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

func (s *Server) queryOrderDemandPool(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
	var body gen.OrderDemandLineQuery
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit := 200
	if body.Limit != nil {
		limit = int(*body.Limit)
	}
	items, err := s.Orders.ListDemandPool(r.Context(), actor, order.DemandPoolQuery{
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

func (s *Server) previewOrderBOM(w http.ResponseWriter, r *http.Request, actor *authz.Actor) {
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
	preview, err := s.Orders.PreviewBOM(r.Context(), actor, body.BomId, qty)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"materials":  bomPreviewDTO(preview.Materials),
		"byproducts": bomPreviewDTO(preview.Byproducts),
	})
}

func (s *Server) getOrderHistory(w http.ResponseWriter, r *http.Request, actor *authz.Actor, side order.Side, id uuid.UUID) {
	items, err := s.Orders.ListOrderFlow(r.Context(), actor, side, id)
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
