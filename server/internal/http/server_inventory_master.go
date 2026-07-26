package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Server) QueryInvMaterialCategories(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "inv.material_category:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.materialCats.List(r.Context(), materialcategory.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvMaterialCategory(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material_category:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.materialCats.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvMaterialCategory(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.material_category:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.MaterialCategoryCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.materialCats.Create(r.Context(), actor, materialcategory.CreateInput{
		Code: body.Code, Name: body.Name, IsLeaf: body.IsLeaf,
		Active: body.Active, ParentID: body.ParentId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvMaterialCategory(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material_category:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Code     *string         `json:"code,omitempty"`
		Name     *string         `json:"name,omitempty"`
		IsLeaf   *bool           `json:"isLeaf,omitempty"`
		Active   *bool           `json:"active,omitempty"`
		ParentID json.RawMessage `json:"parentId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	parentID, err := nullableUUIDUpdate(body.ParentID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("物料分类", "parentId"))
		return
	}
	item, err := s.materialCats.Update(r.Context(), actor, id, materialcategory.UpdateInput{
		Code: body.Code, Name: body.Name, IsLeaf: body.IsLeaf,
		Active: body.Active, ParentID: parentID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvMaterialCategory(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material_category:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.materialCats.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryInvMaterials(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.materials.List(r.Context(), material.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvMaterial(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.materials.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvMaterial(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.material:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.MaterialCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.materials.Create(r.Context(), actor, material.CreateInput{
		Name: body.Name, Spec: body.Spec, CustomerPartNo: body.CustomerPartNo,
		IsCustomerMaterial: body.IsCustomerMaterial, Active: body.Active,
		CategoryID: body.CategoryId, DefaultUnitID: body.DefaultUnitId,
		CustomerID: body.CustomerId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvMaterial(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name               *string         `json:"name,omitempty"`
		Spec               json.RawMessage `json:"spec,omitempty"`
		CustomerPartNo     json.RawMessage `json:"customerPartNo,omitempty"`
		IsCustomerMaterial *bool           `json:"isCustomerMaterial,omitempty"`
		Active             *bool           `json:"active,omitempty"`
		CategoryID         *uuid.UUID      `json:"categoryId,omitempty"`
		DefaultUnitID      *uuid.UUID      `json:"defaultUnitId,omitempty"`
		CustomerID         json.RawMessage `json:"customerId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	spec, err := nullableStringUpdate(body.Spec)
	if err != nil {
		s.writeError(w, r, nullableStringError("物料", "spec"))
		return
	}
	customerPartNo, err := nullableStringUpdate(body.CustomerPartNo)
	if err != nil {
		s.writeError(w, r, nullableStringError("物料", "customerPartNo"))
		return
	}
	customerID, err := nullableUUIDUpdate(body.CustomerID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("物料", "customerId"))
		return
	}
	input := material.UpdateInput{
		Name: body.Name, IsCustomerMaterial: body.IsCustomerMaterial, Active: body.Active,
		CategoryID: body.CategoryID, DefaultUnitID: body.DefaultUnitID,
	}
	if spec != nil {
		input.Spec = material.OptionalString{Set: true, Value: *spec}
	}
	if customerPartNo != nil {
		input.CustomerPartNo = material.OptionalString{Set: true, Value: *customerPartNo}
	}
	if customerID != nil {
		input.CustomerID = material.OptionalUUID{Set: true, Value: *customerID}
	}
	item, err := s.materials.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvMaterial(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.materials.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryInvMaterialUnits(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.materialUnits.List(r.Context(), materialunit.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvMaterialUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.materialUnits.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvMaterialUnit(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithAnyPermission(r, "inv.material:update", "inv.material:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.MaterialUnitCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.materialUnits.Create(r.Context(), actor, materialunit.CreateInput{
		MaterialID: body.MaterialId, UnitID: body.UnitId, Factor: body.Factor,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvMaterialUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.MaterialUnitUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.materialUnits.Update(r.Context(), actor, id, materialunit.UpdateInput{
		UnitID: body.UnitId, Factor: body.Factor,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvMaterialUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.material:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.materialUnits.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryInvWarehouses(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.warehouse:read")
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
	result, err := s.warehouses.List(r.Context(), actor, warehouse.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) QueryInvOutsourcedWarehouses(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.warehouse:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.WarehouseOutsourcedQuery
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var limit, offset int
	var search string
	if body.Limit != nil {
		limit = *body.Limit
	}
	if body.Offset != nil {
		offset = *body.Offset
	}
	if body.Search != nil {
		search = *body.Search
	}
	var sortBody *gen.Sort
	if body.Sort != nil {
		sortBody = body.Sort
	}
	_, _, _, sort, _ := listParts(listBody{Sort: sortBody})
	filter := make(map[string]json.RawMessage)
	if body.Filter != nil {
		for key, value := range *body.Filter {
			raw, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				s.writeError(w, r, invalidJSON(marshalErr))
				return
			}
			filter[key] = raw
		}
	}
	result, err := s.warehouses.ListOutsourced(
		r.Context(), actor, string(body.PartyType), body.PartyId,
		warehouse.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvWarehouse(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.warehouse:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.warehouses.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvWarehouse(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.warehouse:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.WarehouseCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var partyType *string
	if body.PartyType != nil {
		value := string(*body.PartyType)
		partyType = &value
	}
	item, err := s.warehouses.Create(r.Context(), actor, warehouse.CreateInput{
		Name: body.Name, IsLeaf: body.IsLeaf, Active: body.Active,
		IsOutsourced: body.IsOutsourced, PartyType: partyType, PartyID: body.PartyId,
		AllowNegative: body.AllowNegative, CompanyID: body.CompanyId,
		ParentID: body.ParentId, AccountID: body.AccountId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvWarehouse(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.warehouse:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name          *string         `json:"name,omitempty"`
		IsLeaf        *bool           `json:"isLeaf,omitempty"`
		Active        *bool           `json:"active,omitempty"`
		IsOutsourced  *bool           `json:"isOutsourced,omitempty"`
		PartyType     json.RawMessage `json:"partyType,omitempty"`
		PartyID       json.RawMessage `json:"partyId,omitempty"`
		AllowNegative *bool           `json:"allowNegative,omitempty"`
		ParentID      json.RawMessage `json:"parentId,omitempty"`
		AccountID     json.RawMessage `json:"accountId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	partyType, err := nullableStringUpdate(body.PartyType)
	if err != nil {
		s.writeError(w, r, nullableStringError("仓库", "partyType"))
		return
	}
	partyID, err := nullableUUIDUpdate(body.PartyID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "partyId"))
		return
	}
	parentID, err := nullableUUIDUpdate(body.ParentID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "parentId"))
		return
	}
	accountID, err := nullableUUIDUpdate(body.AccountID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "accountId"))
		return
	}
	input := warehouse.UpdateInput{
		Name: body.Name, IsLeaf: body.IsLeaf, Active: body.Active,
		IsOutsourced: body.IsOutsourced, AllowNegative: body.AllowNegative,
	}
	if partyType != nil {
		input.PartyType = warehouse.OptionalString{Set: true, Value: *partyType}
	}
	if partyID != nil {
		input.PartyID = warehouse.OptionalUUID{Set: true, Value: *partyID}
	}
	if parentID != nil {
		input.ParentID = warehouse.OptionalUUID{Set: true, Value: *parentID}
	}
	if accountID != nil {
		input.AccountID = warehouse.OptionalUUID{Set: true, Value: *accountID}
	}
	item, err := s.warehouses.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvWarehouse(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.warehouse:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.warehouses.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) SeedInvWarehouseDefaults(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.warehouse:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.WarehouseSeedDefaultsInput
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	count, err := s.warehouses.SeedDefaults(r.Context(), actor, body.CompanyId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.WarehouseSeedDefaultsResult{Count: count})
}

func actorWithAnyPermission(r *http.Request, permissions ...string) (*authz.Actor, error) {
	actor, err := requireActor(r)
	if err != nil {
		return nil, err
	}
	for _, permission := range permissions {
		if actor.HasPermission(permission) {
			return actor, nil
		}
	}
	return nil, apierror.New(apierror.CodeForbidden, "无权执行此操作")
}

func nullableUUIDUpdate(raw json.RawMessage) (**uuid.UUID, error) {
	if raw == nil {
		return nil, nil
	}
	var value *uuid.UUID
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func nullableUUIDError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是 UUID 或 null"},
	})
}
