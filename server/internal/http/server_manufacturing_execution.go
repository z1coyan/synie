package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/execution"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func executionListQuery(body listBody) execution.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return execution.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func manufacturingMap(value any) map[string]any {
	data, _ := json.Marshal(value)
	result := map[string]any{}
	_ = json.Unmarshal(data, &result)
	return result
}

func dateWire(value time.Time) string {
	return value.UTC().Format(time.DateOnly)
}

func demandWire(item execution.Demand) map[string]any {
	result := manufacturingMap(item)
	result["status"] = strings.ToUpper(string(item.Status))
	result["demandDate"] = dateWire(item.DemandDate)
	return result
}

func demandItemWire(item execution.DemandItem) map[string]any {
	result := manufacturingMap(item)
	result["status"] = strings.ToUpper(string(item.Status))
	result["fulfillmentMethod"] = strings.ToUpper(string(item.FulfillmentMethod))
	if item.NeedDate != nil {
		result["needDate"] = dateWire(*item.NeedDate)
	}
	return result
}

func workOrderWire(item execution.WorkOrder) map[string]any {
	result := manufacturingMap(item)
	result["status"] = strings.ToUpper(string(item.Status))
	if item.NeedDate != nil {
		result["needDate"] = dateWire(*item.NeedDate)
	}
	return result
}

func outputWire(item execution.Output) map[string]any {
	result := manufacturingMap(item)
	result["status"] = strings.ToUpper(string(item.Status))
	result["outputDate"] = dateWire(item.OutputDate)
	return result
}

func outputItemWire(item execution.OutputItem) map[string]any {
	return manufacturingMap(item)
}

func demandListWire(result execution.DemandList) map[string]any {
	items := make([]map[string]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, demandWire(item))
	}
	return map[string]any{"count": result.Count, "results": items}
}

func demandItemListWire(result execution.DemandItemList) map[string]any {
	items := make([]map[string]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, demandItemWire(item))
	}
	return map[string]any{"count": result.Count, "results": items}
}

func workOrderListWire(result execution.WorkOrderList) map[string]any {
	items := make([]map[string]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, workOrderWire(item))
	}
	return map[string]any{"count": result.Count, "results": items}
}

func outputListWire(result execution.OutputList) map[string]any {
	items := make([]map[string]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, outputWire(item))
	}
	return map[string]any{"count": result.Count, "results": items}
}

func outputItemListWire(result execution.OutputItemList) map[string]any {
	items := make([]map[string]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, outputItemWire(item))
	}
	return map[string]any{"count": result.Count, "results": items}
}

func (s *Server) QueryManufacturingDemands(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, executionListQuery, s.ManufacturingExecution.ListDemands,
		func(result execution.DemandList) any { return demandListWire(result) })
}

func (s *Server) GetManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.GetDemand(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandWire(item))
}

func (s *Server) CreateManufacturingDemand(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:create")
	if !ok {
		return
	}
	var body gen.ManufacturingDemandCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var demandDate *time.Time
	if body.DemandDate != nil {
		value := body.DemandDate.Time
		demandDate = &value
	}
	item, err := s.ManufacturingExecution.CreateDemand(r.Context(), actor, execution.CreateDemandInput{
		CompanyID: body.CompanyId, DemandNo: body.DemandNo, DemandDate: demandDate, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, demandWire(item))
}

func (s *Server) UpdateManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:update")
	if !ok {
		return
	}
	var body struct {
		DemandNo   *string             `json:"demandNo,omitempty"`
		DemandDate *openapi_types.Date `json:"demandDate,omitempty"`
		Remarks    json.RawMessage     `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var demandDate *time.Time
	if body.DemandDate != nil {
		value := body.DemandDate.Time
		demandDate = &value
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("履约需求单", "remarks"))
		return
	}
	item, err := s.ManufacturingExecution.UpdateDemand(r.Context(), actor, id, execution.UpdateDemandInput{
		DemandNo: body.DemandNo, DemandDate: demandDate, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandWire(item))
}

func (s *Server) DeleteManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingExecution.DeleteDemand(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) ConfirmManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.manufacturingDemandAction(w, r, id, "mfg.demand:confirm", s.ManufacturingExecution.ConfirmDemand)
}

func (s *Server) CloseManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.manufacturingDemandAction(w, r, id, "mfg.demand:close", s.ManufacturingExecution.CloseDemand)
}

func (s *Server) VoidManufacturingDemand(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.manufacturingDemandAction(w, r, id, "mfg.demand:void", s.ManufacturingExecution.VoidDemand)
}

func (s *Server) manufacturingDemandAction(
	w http.ResponseWriter,
	r *http.Request,
	id uuid.UUID,
	permission string,
	action func(context.Context, *authz.Actor, uuid.UUID) (execution.Demand, error),
) {
	actor, ok := s.manufacturingActor(w, r, permission)
	if !ok {
		return
	}
	item, err := action(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandWire(item))
}

func (s *Server) QueryManufacturingDemandItems(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, executionListQuery, s.ManufacturingExecution.ListDemandItems,
		func(result execution.DemandItemList) any { return demandItemListWire(result) })
}

func (s *Server) GetManufacturingDemandItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.GetDemandItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandItemWire(item))
}

func (s *Server) CreateManufacturingDemandItem(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:create")
	if !ok {
		return
	}
	var body gen.ManufacturingDemandItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "需求行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var needDate *time.Time
	if body.NeedDate != nil {
		value := body.NeedDate.Time
		needDate = &value
	}
	item, err := s.ManufacturingExecution.CreateDemandItem(r.Context(), actor, execution.CreateDemandItemInput{
		DemandID: body.DemandId, Idx: body.Idx, MaterialID: body.MaterialId,
		UnitID: body.UnitId, Qty: qty, NeedDate: needDate,
		FulfillmentMethod: execution.FulfillmentMethod(strings.ToLower(string(body.FulfillmentMethod))),
		SalesOrderItemID:  body.SalesOrderItemId, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, demandItemWire(item))
}

func (s *Server) UpdateManufacturingDemandItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:update")
	if !ok {
		return
	}
	var body struct {
		Idx               *int64          `json:"idx,omitempty"`
		MaterialID        *uuid.UUID      `json:"materialId,omitempty"`
		UnitID            *uuid.UUID      `json:"unitId,omitempty"`
		Qty               *string         `json:"qty,omitempty"`
		NeedDate          json.RawMessage `json:"needDate,omitempty"`
		FulfillmentMethod *string         `json:"fulfillmentMethod,omitempty"`
		SalesOrderItemID  json.RawMessage `json:"salesOrderItemId,omitempty"`
		Remarks           json.RawMessage `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "需求行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	needDate, err := optionalDateUpdate(body.NeedDate)
	if err != nil {
		s.writeError(w, r, apierror.Validation("需求行参数不合法", map[string][]string{"needDate": {"必须是 YYYY-MM-DD 或 null"}}))
		return
	}
	salesOrderItemID, err := optionalUpdate[uuid.UUID](body.SalesOrderItemID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("需求行", "salesOrderItemId"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("需求行", "remarks"))
		return
	}
	var method *execution.FulfillmentMethod
	if body.FulfillmentMethod != nil {
		value := execution.FulfillmentMethod(strings.ToLower(*body.FulfillmentMethod))
		method = &value
	}
	item, err := s.ManufacturingExecution.UpdateDemandItem(r.Context(), actor, id, execution.UpdateDemandItemInput{
		Idx: body.Idx, MaterialID: body.MaterialID, UnitID: body.UnitID, Qty: qty,
		NeedDate: needDate, FulfillmentMethod: method, SalesOrderItemID: salesOrderItemID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandItemWire(item))
}

func (s *Server) DeleteManufacturingDemandItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:update")
	if !ok {
		return
	}
	if err := s.ManufacturingExecution.DeleteDemandItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) CompleteManufacturingDemandItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:update")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.CompleteDemandItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandItemWire(item))
}

func (s *Server) ChangeManufacturingDemandItemFulfillment(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:update")
	if !ok {
		return
	}
	var body gen.ManufacturingDemandItemFulfillmentUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingExecution.ChangeFulfillment(r.Context(), actor, id,
		execution.FulfillmentMethod(strings.ToLower(string(body.FulfillmentMethod))))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, demandItemWire(item))
}

func (s *Server) GetManufacturingSalesItemOccupancies(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.demand:read")
	if !ok {
		return
	}
	var body gen.ManufacturingSalesItemOccupancyRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	items, err := s.ManufacturingExecution.SalesOccupancies(r.Context(), actor, body.SalesOrderItemIds)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"results": items})
}

func (s *Server) QueryManufacturingWorkOrders(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, executionListQuery, s.ManufacturingExecution.ListWorkOrders,
		func(result execution.WorkOrderList) any { return workOrderListWire(result) })
}

func (s *Server) GetManufacturingWorkOrder(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.GetWorkOrder(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, workOrderWire(item))
}

func (s *Server) CreateManufacturingWorkOrder(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:create")
	if !ok {
		return
	}
	var body gen.ManufacturingWorkOrderCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingExecution.CreateWorkOrder(r.Context(), actor, execution.CreateWorkOrderInput{
		DemandItemID: body.DemandItemId, WorkOrderNo: body.WorkOrderNo,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, workOrderWire(item))
}

func (s *Server) UpdateManufacturingWorkOrder(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:update")
	if !ok {
		return
	}
	var body gen.ManufacturingWorkOrderUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if body.WorkOrderNo == nil {
		s.writeError(w, r, apierror.Validation("生产工单参数不合法", map[string][]string{"workOrderNo": {"必填"}}))
		return
	}
	item, err := s.ManufacturingExecution.UpdateWorkOrder(r.Context(), actor, id,
		execution.UpdateWorkOrderInput{WorkOrderNo: *body.WorkOrderNo})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, workOrderWire(item))
}

func (s *Server) DeleteManufacturingWorkOrder(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingExecution.DeleteWorkOrder(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) VoidManufacturingWorkOrder(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.work_order:void")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.VoidWorkOrder(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, workOrderWire(item))
}

func (s *Server) QueryManufacturingOutputs(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, executionListQuery, s.ManufacturingExecution.ListOutputs,
		func(result execution.OutputList) any { return outputListWire(result) })
}

func (s *Server) GetManufacturingOutput(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.GetOutput(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outputWire(item))
}

func (s *Server) CreateManufacturingOutput(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:create")
	if !ok {
		return
	}
	var body gen.ManufacturingOutputCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var outputDate *time.Time
	if body.OutputDate != nil {
		value := body.OutputDate.Time
		outputDate = &value
	}
	item, err := s.ManufacturingExecution.CreateOutput(r.Context(), actor, execution.CreateOutputInput{
		CompanyID: body.CompanyId, OutputNo: body.OutputNo, OutputDate: outputDate,
		WarehouseID: body.WarehouseId, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outputWire(item))
}

func (s *Server) UpdateManufacturingOutput(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:update")
	if !ok {
		return
	}
	var body struct {
		OutputNo    *string             `json:"outputNo,omitempty"`
		OutputDate  *openapi_types.Date `json:"outputDate,omitempty"`
		WarehouseID json.RawMessage     `json:"warehouseId,omitempty"`
		Remarks     json.RawMessage     `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var outputDate *time.Time
	if body.OutputDate != nil {
		value := body.OutputDate.Time
		outputDate = &value
	}
	warehouseID, err := optionalUpdate[uuid.UUID](body.WarehouseID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("生产入库单", "warehouseId"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("生产入库单", "remarks"))
		return
	}
	item, err := s.ManufacturingExecution.UpdateOutput(r.Context(), actor, id, execution.UpdateOutputInput{
		OutputNo: body.OutputNo, OutputDate: outputDate, WarehouseID: warehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outputWire(item))
}

func (s *Server) DeleteManufacturingOutput(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingExecution.DeleteOutput(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditManufacturingOutput(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.manufacturingOutputAction(w, r, id, "mfg.output:audit", s.ManufacturingExecution.AuditOutput)
}

func (s *Server) VoidManufacturingOutput(w http.ResponseWriter, r *http.Request, id gen.ID) {
	s.manufacturingOutputAction(w, r, id, "mfg.output:void", s.ManufacturingExecution.VoidOutput)
}

func (s *Server) manufacturingOutputAction(
	w http.ResponseWriter,
	r *http.Request,
	id uuid.UUID,
	permission string,
	action func(context.Context, *authz.Actor, uuid.UUID) (execution.Output, error),
) {
	actor, ok := s.manufacturingActor(w, r, permission)
	if !ok {
		return
	}
	item, err := action(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outputWire(item))
}

func (s *Server) QueryManufacturingOutputItems(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, executionListQuery, s.ManufacturingExecution.ListOutputItems,
		func(result execution.OutputItemList) any { return outputItemListWire(result) })
}

func (s *Server) GetManufacturingOutputItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingExecution.GetOutputItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outputItemWire(item))
}

func (s *Server) CreateManufacturingOutputItem(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:create")
	if !ok {
		return
	}
	var body gen.ManufacturingOutputItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "生产入库行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingExecution.CreateOutputItem(r.Context(), actor, execution.CreateOutputItemInput{
		OutputID: body.OutputId, Idx: body.Idx, WorkOrderID: body.WorkOrderId,
		UnitID: body.UnitId, Qty: qty, WarehouseID: body.WarehouseId, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, outputItemWire(item))
}

func (s *Server) UpdateManufacturingOutputItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:update")
	if !ok {
		return
	}
	var body struct {
		Idx         *int64          `json:"idx,omitempty"`
		WorkOrderID *uuid.UUID      `json:"workOrderId,omitempty"`
		UnitID      *uuid.UUID      `json:"unitId,omitempty"`
		Qty         *string         `json:"qty,omitempty"`
		WarehouseID *uuid.UUID      `json:"warehouseId,omitempty"`
		Remarks     json.RawMessage `json:"remarks,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "生产入库行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("生产入库行", "remarks"))
		return
	}
	item, err := s.ManufacturingExecution.UpdateOutputItem(r.Context(), actor, id, execution.UpdateOutputItemInput{
		Idx: body.Idx, WorkOrderID: body.WorkOrderID, UnitID: body.UnitID, Qty: qty,
		WarehouseID: body.WarehouseID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, outputItemWire(item))
}

func (s *Server) DeleteManufacturingOutputItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.output:update")
	if !ok {
		return
	}
	if err := s.ManufacturingExecution.DeleteOutputItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
