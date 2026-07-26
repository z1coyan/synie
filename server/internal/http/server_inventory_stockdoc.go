package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func (s *Server) QueryInvStockEntries(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_entry:read")
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
	result, err := s.stockEntries.List(r.Context(), actor, stockentry.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockEntry(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_entry:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockEntries.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryInvStockBalance(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_entry:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockBalanceQuery
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	rows, err := s.stockEntries.Balance(r.Context(), actor, stockentry.BalanceQuery{
		CompanyID: body.CompanyId, AsOf: body.AsOf,
		WarehouseID: body.WarehouseId, MaterialID: body.MaterialId, HideZero: body.HideZero,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"results": rows})
}

func (s *Server) QueryInvStockDocs(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_doc:read")
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
	result, err := s.stockDocs.List(r.Context(), actor, stockdoc.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockDoc(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockDocs.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockDoc(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_doc:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockDocCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.stockDocs.Create(r.Context(), actor, stockdoc.CreateInput{
		DocNo: body.DocNo, Direction: stockdoc.Direction(body.Direction),
		DocDate: body.DocDate, Summary: body.Summary, Remarks: body.Remarks,
		CompanyID: body.CompanyId, WarehouseID: body.WarehouseId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockDoc(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		DocNo       *string         `json:"docNo,omitempty"`
		Direction   *string         `json:"direction,omitempty"`
		DocDate     *time.Time      `json:"docDate,omitempty"`
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
		s.writeError(w, r, nullableStringError("手工出入库单", "summary"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工出入库单", "remarks"))
		return
	}
	var direction *stockdoc.Direction
	if body.Direction != nil {
		value := stockdoc.Direction(*body.Direction)
		direction = &value
	}
	input := stockdoc.UpdateInput{
		DocNo: body.DocNo, Direction: direction, WarehouseID: body.WarehouseID,
	}
	if body.DocDate != nil {
		input.DocDate = body.DocDate
	}
	if summary != nil {
		input.Summary = summary
	}
	if remarks != nil {
		input.Remarks = remarks
	}
	item, err := s.stockDocs.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockDoc(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockDocs.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditInvStockDoc(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:audit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockDocs.Audit(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) VoidInvStockDoc(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:void")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockDocs.Void(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryInvStockDocItems(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_doc:read")
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
	result, err := s.stockDocs.QueryItems(r.Context(), actor, stockdoc.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockDocItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockDocs.GetItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockDocItem(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_doc:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockDocItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "手工出入库单行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockDocs.CreateItem(r.Context(), actor, stockdoc.CreateItemInput{
		StockDocID: body.StockDocId, Idx: body.Idx, Qty: qty,
		MaterialID: body.MaterialId, UnitID: body.UnitId, Remark: body.Remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockDocItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Idx        *int64          `json:"idx,omitempty"`
		Qty        *string         `json:"qty,omitempty"`
		MaterialID *uuid.UUID      `json:"materialId,omitempty"`
		UnitID     *uuid.UUID      `json:"unitId,omitempty"`
		Remark     json.RawMessage `json:"remark,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := optionalDecimalInput(body.Qty, "手工出入库单行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remark, err := nullableStringUpdate(body.Remark)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工出入库单行", "remark"))
		return
	}
	item, err := s.stockDocs.UpdateItem(r.Context(), actor, id, stockdoc.UpdateItemInput{
		Idx: body.Idx, Qty: qty, MaterialID: body.MaterialID,
		UnitID: body.UnitID, Remark: remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockDocItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_doc:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockDocs.DeleteItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decimalInput(raw, resource, field string) (decimal.Decimal, error) {
	value, err := decimal.NewFromString(raw)
	if err != nil {
		return decimal.Decimal{}, apierror.Validation(resource+"参数不合法", map[string][]string{
			field: {"必须是十进制数字字符串"},
		})
	}
	return value, nil
}

func optionalDecimalInput(raw *string, resource, field string) (*decimal.Decimal, error) {
	if raw == nil {
		return nil, nil
	}
	value, err := decimalInput(*raw, resource, field)
	if err != nil {
		return nil, err
	}
	return &value, nil
}
