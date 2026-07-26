package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryInvStockCounts(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
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
	result, err := s.stockCounts.List(r.Context(), actor, stockcount.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockCount(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_count:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockCountCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	items := make([]stockcount.CreateItemInput, 0)
	if body.Items != nil {
		items = make([]stockcount.CreateItemInput, 0, len(*body.Items))
		for index, raw := range *body.Items {
			counted, parseErr := optionalDecimalInput(
				raw.CountedQuantity, "库存盘点单", "items.countedQuantity",
			)
			if parseErr != nil {
				s.writeError(w, r, apierror.Validation("库存盘点单参数不合法", map[string][]string{
					"items": {parseErr.Error(), "第 " + decimal.NewFromInt(int64(index+1)).String() + " 行"},
				}))
				return
			}
			items = append(items, stockcount.CreateItemInput{
				MaterialID: raw.MaterialId, UnitID: raw.UnitId,
				CountedQuantity: counted, Remark: raw.Remark,
			})
		}
	}
	loadAll := body.LoadAll != nil && *body.LoadAll
	item, err := s.stockCounts.Create(r.Context(), actor, stockcount.CreateInput{
		DocNo: body.DocNo, PostingDate: body.PostingDate,
		Summary: body.Summary, Remarks: body.Remarks,
		CompanyID: body.CompanyId, WarehouseID: body.WarehouseId,
		Items: items, LoadAll: loadAll,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		DocNo       *string         `json:"docNo,omitempty"`
		PostingDate *time.Time      `json:"postingDate,omitempty"`
		Summary     json.RawMessage `json:"summary,omitempty"`
		Remarks     json.RawMessage `json:"remarks,omitempty"`
		WarehouseID *uuid.UUID      `json:"warehouseId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	summary, err := nullableStringUpdate(body.Summary)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单", "summary"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单", "remarks"))
		return
	}
	item, err := s.stockCounts.Update(r.Context(), actor, id, stockcount.UpdateInput{
		DocNo: body.DocNo, PostingDate: body.PostingDate,
		Summary: summary, Remarks: remarks, WarehouseID: body.WarehouseID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockCounts.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) RefreshInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.Refresh(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) ApproveInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:approve")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.Approve(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CancelInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:cancel")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.Cancel(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryInvStockCountItems(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
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
	result, err := s.stockCounts.QueryItems(r.Context(), actor, stockcount.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockCountItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.GetItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockCountItem(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_count:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockCountItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	counted, err := optionalDecimalInput(
		body.CountedQuantity, "库存盘点单行", "countedQuantity",
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockCounts.CreateItem(r.Context(), actor, stockcount.CreateItemInput{
		CountID: body.CountId, MaterialID: body.MaterialId,
		UnitID: body.UnitId, CountedQuantity: counted, Remark: body.Remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockCountItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		MaterialID      *uuid.UUID      `json:"materialId,omitempty"`
		UnitID          *uuid.UUID      `json:"unitId,omitempty"`
		CountedQuantity json.RawMessage `json:"countedQuantity,omitempty"`
		Remark          json.RawMessage `json:"remark,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	counted, err := nullableDecimalUpdate(
		body.CountedQuantity, "库存盘点单行", "countedQuantity",
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remark, err := nullableStringUpdate(body.Remark)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单行", "remark"))
		return
	}
	item, err := s.stockCounts.UpdateItem(r.Context(), actor, id, stockcount.UpdateItemInput{
		MaterialID: body.MaterialID, UnitID: body.UnitID,
		CountedQuantity: counted, Remark: remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockCountItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockCounts.DeleteItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func nullableDecimalUpdate(
	raw json.RawMessage,
	resource string,
	field string,
) (**decimal.Decimal, error) {
	if raw == nil {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, apierror.Validation(resource+"参数不合法", map[string][]string{
			field: {"必须是十进制数字字符串或 null"},
		})
	}
	if value == nil {
		var result *decimal.Decimal
		return &result, nil
	}
	parsed, err := decimalInput(*value, resource, field)
	if err != nil {
		return nil, err
	}
	result := &parsed
	return &result, nil
}
