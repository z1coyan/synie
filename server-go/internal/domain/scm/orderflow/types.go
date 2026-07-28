package orderflow

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Item struct {
	ID             string          `json:"id"`
	FlowType       string          `json:"flowType"`
	VoucherNo      string          `json:"voucherNo"`
	VoucherDate    time.Time       `json:"voucherDate"`
	Status         string          `json:"status"`
	CompanyID      uuid.UUID       `json:"companyId"`
	OrderID        uuid.UUID       `json:"orderId"`
	OrderItemID    uuid.UUID       `json:"orderItemId"`
	MaterialCode   string          `json:"materialCode"`
	MaterialName   string          `json:"materialName"`
	MaterialSpec   *string         `json:"materialSpec"`
	CustomerPartNo *string         `json:"customerPartNo"`
	UnitName       string          `json:"unitName"`
	Qty            decimal.Decimal `json:"qty"`
}

type ListQuery struct {
	Limit       int
	Offset      int
	Search      string
	Sort        *filterbuild.Sort
	Filter      map[string]json.RawMessage
	OrderID     *uuid.UUID
	OrderItemID *uuid.UUID
}

type ListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}
