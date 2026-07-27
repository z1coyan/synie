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
)

func materialCategoryListQuery(body listBody) materialcategory.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return materialcategory.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) QueryInvMaterialCategories(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.material_category:read", materialCategoryListQuery,
		ignoreActor(s.MaterialCats.List), passthroughListResponse)
}

func (s *Server) GetInvMaterialCategory(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material_category:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.MaterialCats.Get(r.Context(), id)
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
	item, err := s.MaterialCats.Create(r.Context(), actor, materialcategory.CreateInput{
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
	parentID, err := optionalUpdate[uuid.UUID](body.ParentID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("物料分类", "parentId"))
		return
	}
	item, err := s.MaterialCats.Update(r.Context(), actor, id, materialcategory.UpdateInput{
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
	if err := s.MaterialCats.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func materialListQuery(body listBody) material.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return material.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryInvMaterials(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.material:read", materialListQuery,
		ignoreActor(s.Materials.List), passthroughListResponse)
}

func (s *Server) GetInvMaterial(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Materials.Get(r.Context(), id)
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
	item, err := s.Materials.Create(r.Context(), actor, material.CreateInput{
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
	spec, err := optionalUpdate[string](body.Spec)
	if err != nil {
		s.writeError(w, r, nullableStringError("物料", "spec"))
		return
	}
	customerPartNo, err := optionalUpdate[string](body.CustomerPartNo)
	if err != nil {
		s.writeError(w, r, nullableStringError("物料", "customerPartNo"))
		return
	}
	customerID, err := optionalUpdate[uuid.UUID](body.CustomerID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("物料", "customerId"))
		return
	}
	input := material.UpdateInput{
		Name: body.Name, IsCustomerMaterial: body.IsCustomerMaterial, Active: body.Active,
		CategoryID: body.CategoryID, DefaultUnitID: body.DefaultUnitID,
		Spec: spec, CustomerPartNo: customerPartNo, CustomerID: customerID,
	}
	item, err := s.Materials.Update(r.Context(), actor, id, input)
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
	if err := s.Materials.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func materialUnitListQuery(body listBody) materialunit.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return materialunit.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryInvMaterialUnits(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.material:read", materialUnitListQuery,
		ignoreActor(s.MaterialUnits.List), passthroughListResponse)
}

func (s *Server) GetInvMaterialUnit(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "inv.material:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.MaterialUnits.Get(r.Context(), id)
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
	item, err := s.MaterialUnits.Create(r.Context(), actor, materialunit.CreateInput{
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
	item, err := s.MaterialUnits.Update(r.Context(), actor, id, materialunit.UpdateInput{
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
	if err := s.MaterialUnits.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func warehouseListQuery(body listBody) warehouse.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return warehouse.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryInvWarehouses(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.warehouse:read", warehouseListQuery, s.Warehouses.List, passthroughListResponse)
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
	result, err := s.Warehouses.ListOutsourced(
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
	item, err := s.Warehouses.Get(r.Context(), actor, id)
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
	item, err := s.Warehouses.Create(r.Context(), actor, warehouse.CreateInput{
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
	partyType, err := optionalUpdate[string](body.PartyType)
	if err != nil {
		s.writeError(w, r, nullableStringError("仓库", "partyType"))
		return
	}
	partyID, err := optionalUpdate[uuid.UUID](body.PartyID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "partyId"))
		return
	}
	parentID, err := optionalUpdate[uuid.UUID](body.ParentID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "parentId"))
		return
	}
	accountID, err := optionalUpdate[uuid.UUID](body.AccountID)
	if err != nil {
		s.writeError(w, r, nullableUUIDError("仓库", "accountId"))
		return
	}
	input := warehouse.UpdateInput{
		Name: body.Name, IsLeaf: body.IsLeaf, Active: body.Active,
		IsOutsourced: body.IsOutsourced, AllowNegative: body.AllowNegative,
		PartyType: partyType, PartyID: partyID, ParentID: parentID, AccountID: accountID,
	}
	item, err := s.Warehouses.Update(r.Context(), actor, id, input)
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
	if err := s.Warehouses.Delete(r.Context(), actor, id); err != nil {
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
	count, err := s.Warehouses.SeedDefaults(r.Context(), actor, body.CompanyId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.WarehouseSeedDefaultsResult{Count: count})
}
