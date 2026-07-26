package stockcount

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Status string

const (
	StatusDraft     Status = "DRAFT"
	StatusAudited   Status = "AUDITED"
	StatusCancelled Status = "CANCELLED"
)

type Count struct {
	ID              uuid.UUID  `json:"id"`
	DocNo           string     `json:"docNo"`
	PostingDate     time.Time  `json:"postingDate"`
	Summary         *string    `json:"summary"`
	Remarks         *string    `json:"remarks"`
	Status          Status     `json:"status"`
	AuditedAt       *time.Time `json:"auditedAt"`
	SnapshotTakenAt time.Time  `json:"snapshotTakenAt"`
	InsertedAt      time.Time  `json:"insertedAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	CompanyID       uuid.UUID  `json:"companyId"`
	WarehouseID     uuid.UUID  `json:"warehouseId"`
	CreatedByID     *uuid.UUID `json:"createdById"`
	AuditedByID     *uuid.UUID `json:"auditedById"`
}

type Item struct {
	ID               uuid.UUID        `json:"id"`
	CountedQuantity  *decimal.Decimal `json:"countedQuantity"`
	ConvertedCounted *decimal.Decimal `json:"convertedCounted"`
	BookQuantity     decimal.Decimal  `json:"bookQuantity"`
	MaterialCode     string           `json:"materialCode"`
	MaterialName     string           `json:"materialName"`
	MaterialSpec     *string          `json:"materialSpec"`
	UnitName         string           `json:"unitName"`
	Remark           *string          `json:"remark"`
	InsertedAt       time.Time        `json:"insertedAt"`
	UpdatedAt        time.Time        `json:"updatedAt"`
	CountID          uuid.UUID        `json:"countId"`
	CompanyID        uuid.UUID        `json:"companyId"`
	MaterialID       uuid.UUID        `json:"materialId"`
	UnitID           uuid.UUID        `json:"unitId"`
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
	Results []Count `json:"results"`
}

type CreateInput struct {
	DocNo       *string
	PostingDate *time.Time
	Summary     *string
	Remarks     *string
	CompanyID   uuid.UUID
	WarehouseID uuid.UUID
	Items       []CreateItemInput
	LoadAll     bool
}

type UpdateInput struct {
	DocNo       *string
	PostingDate *time.Time
	Summary     **string
	Remarks     **string
	WarehouseID *uuid.UUID
}

type CreateItemInput struct {
	CountID         uuid.UUID
	MaterialID      uuid.UUID
	UnitID          uuid.UUID
	CountedQuantity *decimal.Decimal
	Remark          *string
}

type UpdateItemInput struct {
	MaterialID      *uuid.UUID
	UnitID          *uuid.UUID
	CountedQuantity **decimal.Decimal
	Remark          **string
}
