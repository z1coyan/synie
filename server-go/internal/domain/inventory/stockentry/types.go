package stockentry

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Entry struct {
	ID          uuid.UUID       `json:"id"`
	Seq         int64           `json:"seq"`
	Quantity    decimal.Decimal `json:"quantity"`
	PostingDate time.Time       `json:"postingDate"`
	VoucherType string          `json:"voucherType"`
	VoucherID   uuid.UUID       `json:"voucherId"`
	VoucherNo   string          `json:"voucherNo"`
	IsCancelled bool            `json:"isCancelled"`
	CancelledAt *time.Time      `json:"cancelledAt"`
	Remarks     *string         `json:"remarks"`
	InsertedAt  time.Time       `json:"insertedAt"`
	CompanyID   uuid.UUID       `json:"companyId"`
	WarehouseID uuid.UUID       `json:"warehouseId"`
	MaterialID  uuid.UUID       `json:"materialId"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64   `json:"count"`
	Results []Entry `json:"results"`
}

type BalanceQuery struct {
	CompanyID   uuid.UUID
	AsOf        *time.Time
	WarehouseID *uuid.UUID
	MaterialID  *uuid.UUID
	HideZero    *bool
}
