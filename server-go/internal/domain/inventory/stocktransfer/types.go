package stocktransfer

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Status string

const (
	StatusDraft    Status = "DRAFT"
	StatusShipped  Status = "SHIPPED"
	StatusReceived Status = "RECEIVED"
)

type Transfer struct {
	ID                 uuid.UUID  `json:"id"`
	DocNo              string     `json:"docNo"`
	DocDate            time.Time  `json:"docDate"`
	Summary            *string    `json:"summary"`
	Remarks            *string    `json:"remarks"`
	Status             Status     `json:"status"`
	ShippedAt          *time.Time `json:"shippedAt"`
	ReceivedAt         *time.Time `json:"receivedAt"`
	InsertedAt         time.Time  `json:"insertedAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
	CompanyID          uuid.UUID  `json:"companyId"`
	FromWarehouseID    uuid.UUID  `json:"fromWarehouseId"`
	ToWarehouseID      uuid.UUID  `json:"toWarehouseId"`
	TransitWarehouseID uuid.UUID  `json:"transitWarehouseId"`
	CreatedByID        *uuid.UUID `json:"createdById"`
	ShippedByID        *uuid.UUID `json:"shippedById"`
	ReceivedByID       *uuid.UUID `json:"receivedById"`
}

type Item struct {
	ID              uuid.UUID        `json:"id"`
	Idx             int64            `json:"idx"`
	Qty             decimal.Decimal  `json:"qty"`
	BaseQty         decimal.Decimal  `json:"baseQty"`
	ReceivedQty     *decimal.Decimal `json:"receivedQty"`
	MaterialCode    string           `json:"materialCode"`
	MaterialName    string           `json:"materialName"`
	MaterialSpec    *string          `json:"materialSpec"`
	UnitName        string           `json:"unitName"`
	Remark          *string          `json:"remark"`
	InsertedAt      time.Time        `json:"insertedAt"`
	UpdatedAt       time.Time        `json:"updatedAt"`
	StockTransferID uuid.UUID        `json:"stockTransferId"`
	CompanyID       uuid.UUID        `json:"companyId"`
	MaterialID      uuid.UUID        `json:"materialId"`
	UnitID          uuid.UUID        `json:"unitId"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64      `json:"count"`
	Results []Transfer `json:"results"`
}

type CreateInput struct {
	DocNo              *string
	DocDate            *time.Time
	Summary            *string
	Remarks            *string
	CompanyID          uuid.UUID
	FromWarehouseID    uuid.UUID
	ToWarehouseID      uuid.UUID
	TransitWarehouseID uuid.UUID
}

type UpdateInput struct {
	DocNo              *string
	DocDate            *time.Time
	Summary            optional.Optional[string]
	Remarks            optional.Optional[string]
	FromWarehouseID    *uuid.UUID
	ToWarehouseID      *uuid.UUID
	TransitWarehouseID *uuid.UUID
}

type CreateItemInput struct {
	StockTransferID uuid.UUID
	Idx             int64
	Qty             decimal.Decimal
	MaterialID      uuid.UUID
	UnitID          uuid.UUID
	Remark          *string
}

type UpdateItemInput struct {
	Idx        *int64
	Qty        *decimal.Decimal
	MaterialID *uuid.UUID
	UnitID     *uuid.UUID
	Remark     optional.Optional[string]
}

type Receipt struct {
	ItemID uuid.UUID
	Qty    decimal.Decimal
}

type ReceiveInput struct {
	// Nil means full receipt. A non-nil slice must cover every item exactly once.
	Receipts []Receipt
}
