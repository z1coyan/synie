package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// manufacturingActor 要求 actor 具备 permissions 中的任一权限。
func (s *Server) manufacturingActor(w http.ResponseWriter, r *http.Request, permissions ...string) (*authz.Actor, bool) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return nil, false
	}
	for _, permission := range permissions {
		if actor.HasPermission(permission) {
			return actor, true
		}
	}
	s.writeError(w, r, apierror.New(apierror.CodeForbidden, "无权限执行制造操作"))
	return nil, false
}

func masterListQuery(body listBody) master.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return master.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func optionalCode(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func rawOptionalString(raw json.RawMessage, label, field string) (master.OptionalString, error) {
	if raw == nil {
		return master.OptionalString{}, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return master.OptionalString{}, nullableStringError(label, field)
	}
	return master.OptionalString{Set: true, Value: value}, nil
}

func (s *Server) QueryManufacturingOperations(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.operation:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery, s.ManufacturingMaster.ListOperations, passthroughListResponse)
}

func (s *Server) GetManufacturingOperation(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.operation:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetOperation(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingOperation(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.operation:create")
	if !ok {
		return
	}
	var body gen.ManufacturingOperationCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingMaster.CreateOperation(r.Context(), actor, master.HeadCreateInput{
		Code: optionalCode(body.Code), Name: body.Name, Note: body.Note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateManufacturingOperation(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.operation:update")
	if !ok {
		return
	}
	var body struct {
		Name *string         `json:"name,omitempty"`
		Note json.RawMessage `json:"note,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	note, err := rawOptionalString(body.Note, "工序", "note")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.UpdateOperation(r.Context(), actor, id, master.HeadUpdateInput{
		Name: body.Name, Note: note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingOperation(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.operation:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteOperation(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryManufacturingProcessTemplates(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery, s.ManufacturingMaster.ListTemplates, passthroughListResponse)
}

func (s *Server) GetManufacturingProcessTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetTemplate(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingProcessTemplate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:create")
	if !ok {
		return
	}
	var body gen.ManufacturingProcessTemplateCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingMaster.CreateTemplate(r.Context(), actor, master.HeadCreateInput{
		Code: optionalCode(body.Code), Name: body.Name, Note: body.Note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateManufacturingProcessTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:update")
	if !ok {
		return
	}
	var body struct {
		Name *string         `json:"name,omitempty"`
		Note json.RawMessage `json:"note,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	note, err := rawOptionalString(body.Note, "工艺模板", "note")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.UpdateTemplate(r.Context(), actor, id, master.HeadUpdateInput{
		Name: body.Name, Note: note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingProcessTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteTemplate(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryManufacturingProcessTemplateItems(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery,
		func(ctx context.Context, actor *authz.Actor, query master.ListQuery) (master.ListResult[master.TemplateItem], error) {
			return s.ManufacturingMaster.ListTemplateItems(ctx, actor, nil, query)
		}, passthroughListResponse)
}

func (s *Server) GetManufacturingProcessTemplateItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetTemplateItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingProcessTemplateItem(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:create", "mfg.route_template:update")
	if !ok {
		return
	}
	var body gen.ManufacturingProcessTemplateItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingMaster.CreateTemplateItem(r.Context(), actor, body.TemplateId, master.RouteItemInput{
		Seq: body.Seq, Requirement: body.Requirement, IsOutsourced: body.IsOutsourced != nil && *body.IsOutsourced,
		OperationID: body.OperationId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

type routeItemPatch struct {
	Seq          *int64     `json:"seq,omitempty"`
	Requirement  *string    `json:"requirement,omitempty"`
	IsOutsourced *bool      `json:"isOutsourced,omitempty"`
	OperationID  *uuid.UUID `json:"operationId,omitempty"`
}

func (p routeItemPatch) empty() bool {
	return p.Seq == nil && p.Requirement == nil && p.IsOutsourced == nil && p.OperationID == nil
}

func routePatchInput(currentSeq int64, currentRequirement *string, currentOutsourced bool, currentOperation uuid.UUID, p routeItemPatch) master.RouteItemInput {
	if p.Seq != nil {
		currentSeq = *p.Seq
	}
	if p.Requirement != nil {
		currentRequirement = p.Requirement
	}
	if p.IsOutsourced != nil {
		currentOutsourced = *p.IsOutsourced
	}
	if p.OperationID != nil {
		currentOperation = *p.OperationID
	}
	return master.RouteItemInput{
		Seq: currentSeq, Requirement: currentRequirement, IsOutsourced: currentOutsourced, OperationID: currentOperation,
	}
}

func (s *Server) UpdateManufacturingProcessTemplateItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:update")
	if !ok {
		return
	}
	var body routeItemPatch
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if body.empty() {
		s.writeError(w, r, apierror.Validation("工艺模板行参数不合法", map[string][]string{"body": {"至少提供一个更新字段"}}))
		return
	}
	current, err := s.ManufacturingMaster.GetTemplateItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.UpdateTemplateItem(r.Context(), actor, id,
		routePatchInput(current.Seq, current.Requirement, current.IsOutsourced, current.OperationID, body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingProcessTemplateItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.route_template:update")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteTemplateItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryManufacturingBoms(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery, s.ManufacturingMaster.ListBOMs, passthroughListResponse)
}

func (s *Server) GetManufacturingBom(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetBOM(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingBom(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:create")
	if !ok {
		return
	}
	var body gen.ManufacturingBomCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingMaster.CreateBOM(r.Context(), actor, master.BOMCreateInput{
		Code: optionalCode(body.Code), MaterialID: body.MaterialId, PlanName: body.PlanName, Note: body.Note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateManufacturingBom(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	var body struct {
		PlanName json.RawMessage `json:"planName,omitempty"`
		Note     json.RawMessage `json:"note,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	planName, err := rawOptionalString(body.PlanName, "BOM", "planName")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	note, err := rawOptionalString(body.Note, "BOM", "note")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.UpdateBOM(r.Context(), actor, id, master.BOMUpdateInput{
		PlanName: planName, Note: note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingBom(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:delete")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteBOM(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) ApplyManufacturingBomRouteTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	var body gen.ManufacturingBomApplyRouteTemplate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	items, err := s.ManufacturingMaster.ApplyRouteTemplate(r.Context(), actor, id, body.TemplateId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"count": int64(len(items)), "results": items})
}

func (s *Server) QueryManufacturingBomComponents(w http.ResponseWriter, r *http.Request) {
	s.queryManufacturingComponents(w, r)
}

func (s *Server) queryManufacturingComponents(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery,
		func(ctx context.Context, actor *authz.Actor, query master.ListQuery) (master.ListResult[master.BOMComponent], error) {
			return s.ManufacturingMaster.ListBOMComponents(ctx, actor, nil, query)
		}, passthroughListResponse)
}

func (s *Server) GetManufacturingBomComponent(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetBOMComponent(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func parseDecimal(raw, label, field string) (decimal.Decimal, error) {
	return decimalInput(raw, label, field)
}

func (s *Server) CreateManufacturingBomComponent(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:create", "mfg.bom:update")
	if !ok {
		return
	}
	var body gen.ManufacturingBomComponentCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	quantity, err := parseDecimal(body.Quantity, "BOM配料行", "quantity")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	lossRate, err := optionalDecimalInput(body.LossRate, "BOM配料行", "lossRate")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.CreateBOMComponent(r.Context(), actor, master.ComponentInput{
		BOMID: body.BomId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, LossRate: lossRate, Note: body.Note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

type componentPatch struct {
	MaterialID *uuid.UUID      `json:"materialId,omitempty"`
	UnitID     *uuid.UUID      `json:"unitId,omitempty"`
	Quantity   *string         `json:"quantity,omitempty"`
	LossRate   json.RawMessage `json:"lossRate,omitempty"`
	Note       json.RawMessage `json:"note,omitempty"`
}

func (p componentPatch) empty() bool {
	return p.MaterialID == nil && p.UnitID == nil && p.Quantity == nil && p.LossRate == nil && p.Note == nil
}

func (s *Server) UpdateManufacturingBomComponent(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	var body componentPatch
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if body.empty() {
		s.writeError(w, r, apierror.Validation("BOM配料行参数不合法", map[string][]string{"body": {"至少提供一个更新字段"}}))
		return
	}
	current, err := s.ManufacturingMaster.GetBOMComponent(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	input := master.ComponentInput{
		MaterialID: current.MaterialID, UnitID: current.UnitID, Quantity: current.Quantity,
		LossRate: current.LossRate, Note: current.Note,
	}
	if body.MaterialID != nil {
		input.MaterialID = *body.MaterialID
	}
	if body.UnitID != nil {
		input.UnitID = *body.UnitID
	}
	if body.Quantity != nil {
		input.Quantity, err = parseDecimal(*body.Quantity, "BOM配料行", "quantity")
		if err != nil {
			s.writeError(w, r, err)
			return
		}
	}
	if body.LossRate != nil {
		if string(body.LossRate) == "null" {
			input.LossRate = nil
		} else {
			var raw string
			if json.Unmarshal(body.LossRate, &raw) != nil {
				s.writeError(w, r, apierror.Validation("BOM配料行参数不合法", map[string][]string{"lossRate": {"必须是十进制数字字符串或 null"}}))
				return
			}
			value, parseErr := parseDecimal(raw, "BOM配料行", "lossRate")
			if parseErr != nil {
				s.writeError(w, r, parseErr)
				return
			}
			input.LossRate = &value
		}
	}
	if body.Note != nil {
		if err := json.Unmarshal(body.Note, &input.Note); err != nil {
			s.writeError(w, r, nullableStringError("BOM配料行", "note"))
			return
		}
	}
	item, err := s.ManufacturingMaster.UpdateBOMComponent(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingBomComponent(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteBOMComponent(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryManufacturingBomRoutes(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery,
		func(ctx context.Context, actor *authz.Actor, query master.ListQuery) (master.ListResult[master.BOMRoute], error) {
			return s.ManufacturingMaster.ListBOMRoutes(ctx, actor, nil, query)
		}, passthroughListResponse)
}

func (s *Server) GetManufacturingBomRoute(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetBOMRoute(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingBomRoute(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:create", "mfg.bom:update")
	if !ok {
		return
	}
	var body gen.ManufacturingBomRouteCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.ManufacturingMaster.CreateBOMRoute(r.Context(), actor, body.BomId, master.RouteItemInput{
		Seq: body.Seq, Requirement: body.Requirement, IsOutsourced: body.IsOutsourced != nil && *body.IsOutsourced,
		OperationID: body.OperationId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateManufacturingBomRoute(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	var body routeItemPatch
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if body.empty() {
		s.writeError(w, r, apierror.Validation("BOM工艺路线行参数不合法", map[string][]string{"body": {"至少提供一个更新字段"}}))
		return
	}
	current, err := s.ManufacturingMaster.GetBOMRoute(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.UpdateBOMRoute(r.Context(), actor, id,
		routePatchInput(current.Seq, current.Requirement, current.IsOutsourced, current.OperationID, body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingBomRoute(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteBOMRoute(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryManufacturingBomByproducts(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	queryListAs(s, w, r, actor, masterListQuery,
		func(ctx context.Context, actor *authz.Actor, query master.ListQuery) (master.ListResult[master.BOMByproduct], error) {
			return s.ManufacturingMaster.ListBOMByproducts(ctx, actor, nil, query)
		}, passthroughListResponse)
}

func (s *Server) GetManufacturingBomByproduct(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:read")
	if !ok {
		return
	}
	item, err := s.ManufacturingMaster.GetBOMByproduct(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateManufacturingBomByproduct(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:create", "mfg.bom:update")
	if !ok {
		return
	}
	var body gen.ManufacturingBomByproductCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	quantity, err := parseDecimal(body.Quantity, "BOM副产品行", "quantity")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.ManufacturingMaster.CreateBOMByproduct(r.Context(), actor, master.ByproductInput{
		BOMID: body.BomId, MaterialID: body.MaterialId, UnitID: body.UnitId,
		Quantity: quantity, Note: body.Note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

type byproductPatch struct {
	MaterialID *uuid.UUID      `json:"materialId,omitempty"`
	UnitID     *uuid.UUID      `json:"unitId,omitempty"`
	Quantity   *string         `json:"quantity,omitempty"`
	Note       json.RawMessage `json:"note,omitempty"`
}

func (p byproductPatch) empty() bool {
	return p.MaterialID == nil && p.UnitID == nil && p.Quantity == nil && p.Note == nil
}

func (s *Server) UpdateManufacturingBomByproduct(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	var body byproductPatch
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if body.empty() {
		s.writeError(w, r, apierror.Validation("BOM副产品行参数不合法", map[string][]string{"body": {"至少提供一个更新字段"}}))
		return
	}
	current, err := s.ManufacturingMaster.GetBOMByproduct(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	input := master.ByproductInput{
		MaterialID: current.MaterialID, UnitID: current.UnitID, Quantity: current.Quantity, Note: current.Note,
	}
	if body.MaterialID != nil {
		input.MaterialID = *body.MaterialID
	}
	if body.UnitID != nil {
		input.UnitID = *body.UnitID
	}
	if body.Quantity != nil {
		input.Quantity, err = parseDecimal(*body.Quantity, "BOM副产品行", "quantity")
		if err != nil {
			s.writeError(w, r, err)
			return
		}
	}
	if body.Note != nil {
		if err := json.Unmarshal(body.Note, &input.Note); err != nil {
			s.writeError(w, r, nullableStringError("BOM副产品行", "note"))
			return
		}
	}
	item, err := s.ManufacturingMaster.UpdateBOMByproduct(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteManufacturingBomByproduct(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, ok := s.manufacturingActor(w, r, "mfg.bom:update")
	if !ok {
		return
	}
	if err := s.ManufacturingMaster.DeleteBOMByproduct(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
