package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/http/gen"
)

func (s *Server) QueryInvStockTransfers(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:read")
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
	result, err := s.stockTransfers.List(r.Context(), actor, stocktransfer.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockTransfer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockTransfers.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockTransfer(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockTransferCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.stockTransfers.Create(r.Context(), actor, stocktransfer.CreateInput{
		DocNo: body.DocNo, DocDate: body.DocDate, Summary: body.Summary, Remarks: body.Remarks,
		CompanyID: body.CompanyId, FromWarehouseID: body.FromWarehouseId,
		ToWarehouseID: body.ToWarehouseId, TransitWarehouseID: body.TransitWarehouseId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockTransfer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		DocNo              *string         `json:"docNo,omitempty"`
		DocDate            *time.Time      `json:"docDate,omitempty"`
		Summary            json.RawMessage `json:"summary,omitempty"`
		Remarks            json.RawMessage `json:"remarks,omitempty"`
		FromWarehouseID    *uuid.UUID      `json:"fromWarehouseId,omitempty"`
		ToWarehouseID      *uuid.UUID      `json:"toWarehouseId,omitempty"`
		TransitWarehouseID *uuid.UUID      `json:"transitWarehouseId,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	summary, err := nullableStringUpdate(body.Summary)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工调拨单", "summary"))
		return
	}
	remarks, err := nullableStringUpdate(body.Remarks)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工调拨单", "remarks"))
		return
	}
	item, err := s.stockTransfers.Update(r.Context(), actor, id, stocktransfer.UpdateInput{
		DocNo: body.DocNo, DocDate: body.DocDate, Summary: summary, Remarks: remarks,
		FromWarehouseID: body.FromWarehouseID, ToWarehouseID: body.ToWarehouseID,
		TransitWarehouseID: body.TransitWarehouseID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockTransfer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockTransfers.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) ShipInvStockTransfer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:ship")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockTransfers.Ship(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) ReceiveInvStockTransfer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:receive")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockTransferReceive
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var receipts []stocktransfer.Receipt
	if body.Receipts != nil {
		receipts = make([]stocktransfer.Receipt, 0, len(*body.Receipts))
		for _, raw := range *body.Receipts {
			qty, parseErr := decimalInput(raw.Qty, "手工调拨单收货", "receipts.qty")
			if parseErr != nil {
				s.writeError(w, r, parseErr)
				return
			}
			receipts = append(receipts, stocktransfer.Receipt{ItemID: raw.ItemId, Qty: qty})
		}
	}
	item, err := s.stockTransfers.Receive(
		r.Context(), actor, id, stocktransfer.ReceiveInput{Receipts: receipts},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryInvStockTransferItems(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:read")
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
	result, err := s.stockTransfers.QueryItems(r.Context(), actor, stocktransfer.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) GetInvStockTransferItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockTransfers.GetItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateInvStockTransferItem(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StockTransferItemCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	qty, err := decimalInput(body.Qty, "手工调拨单行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.stockTransfers.CreateItem(r.Context(), actor, stocktransfer.CreateItemInput{
		StockTransferID: body.StockTransferId, Idx: body.Idx, Qty: qty,
		MaterialID: body.MaterialId, UnitID: body.UnitId, Remark: body.Remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateInvStockTransferItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:update")
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
	qty, err := optionalDecimalInput(body.Qty, "手工调拨单行", "qty")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	remark, err := nullableStringUpdate(body.Remark)
	if err != nil {
		s.writeError(w, r, nullableStringError("手工调拨单行", "remark"))
		return
	}
	item, err := s.stockTransfers.UpdateItem(r.Context(), actor, id, stocktransfer.UpdateItemInput{
		Idx: body.Idx, Qty: qty, MaterialID: body.MaterialID,
		UnitID: body.UnitID, Remark: remark,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteInvStockTransferItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "inv.stock_transfer:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.stockTransfers.DeleteItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
