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

func stockCountListQuery(body listBody) stockcount.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return stockcount.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryInvStockCounts(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.stock_count:read", stockCountListQuery, s.StockCounts.List, passthroughListResponse)
}

func (s *Server) GetInvStockCount(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.StockCounts.Get(r.Context(), actor, id)
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
	item, err := s.StockCounts.Create(r.Context(), actor, stockcount.CreateInput{
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
	summary, err := optionalUpdate[string](body.Summary)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单", "summary"))
		return
	}
	remarks, err := optionalUpdate[string](body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单", "remarks"))
		return
	}
	item, err := s.StockCounts.Update(r.Context(), actor, id, stockcount.UpdateInput{
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
	if err := s.StockCounts.Delete(r.Context(), actor, id); err != nil {
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
	item, err := s.StockCounts.Refresh(r.Context(), actor, id)
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
	item, err := s.StockCounts.Approve(r.Context(), actor, id)
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
	item, err := s.StockCounts.Cancel(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryInvStockCountItems(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "inv.stock_count:read", stockCountListQuery, s.StockCounts.QueryItems, passthroughListResponse)
}

func (s *Server) GetInvStockCountItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_count:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.StockCounts.GetItem(r.Context(), actor, id)
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
	item, err := s.StockCounts.CreateItem(r.Context(), actor, stockcount.CreateItemInput{
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
	counted, err := optionalDecimalUpdate(
		body.CountedQuantity, "库存盘点单行", "countedQuantity",
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remark, err := optionalUpdate[string](body.Remark)
	if err != nil {
		s.writeError(w, r, nullableStringError("库存盘点单行", "remark"))
		return
	}
	item, err := s.StockCounts.UpdateItem(r.Context(), actor, id, stockcount.UpdateItemInput{
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
	if err := s.StockCounts.DeleteItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
