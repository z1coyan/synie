// Package master owns manufacturing recipe master data behind one interface.
// Operations, route templates and BOM recipes are global (not company scoped);
// child rows inherit their parent's capability instead of defining new
// permission resources.
package master

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Operation struct {
	ID         uuid.UUID `json:"id"`
	Code       string    `json:"code"`
	Name       string    `json:"name"`
	Note       *string   `json:"note"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type ProcessTemplate struct {
	ID         uuid.UUID `json:"id"`
	Code       string    `json:"code"`
	Name       string    `json:"name"`
	Note       *string   `json:"note"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type TemplateItem struct {
	ID           uuid.UUID `json:"id"`
	Seq          int64     `json:"seq"`
	Requirement  *string   `json:"requirement"`
	IsOutsourced bool      `json:"isOutsourced"`
	InsertedAt   time.Time `json:"insertedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	TemplateID   uuid.UUID `json:"templateId"`
	OperationID  uuid.UUID `json:"operationId"`
}

type BOM struct {
	ID         uuid.UUID `json:"id"`
	Code       string    `json:"code"`
	PlanName   *string   `json:"planName"`
	Note       *string   `json:"note"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	MaterialID uuid.UUID `json:"materialId"`
}

type BOMComponent struct {
	ID         uuid.UUID        `json:"id"`
	Quantity   decimal.Decimal  `json:"quantity"`
	LossRate   *decimal.Decimal `json:"lossRate"`
	Note       *string          `json:"note"`
	InsertedAt time.Time        `json:"insertedAt"`
	UpdatedAt  time.Time        `json:"updatedAt"`
	BOMID      uuid.UUID        `json:"bomId"`
	MaterialID uuid.UUID        `json:"materialId"`
	UnitID     uuid.UUID        `json:"unitId"`
}

type BOMRoute struct {
	ID           uuid.UUID `json:"id"`
	Seq          int64     `json:"seq"`
	Requirement  *string   `json:"requirement"`
	IsOutsourced bool      `json:"isOutsourced"`
	InsertedAt   time.Time `json:"insertedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	BOMID        uuid.UUID `json:"bomId"`
	OperationID  uuid.UUID `json:"operationId"`
}

type BOMByproduct struct {
	ID         uuid.UUID       `json:"id"`
	Quantity   decimal.Decimal `json:"quantity"`
	Note       *string         `json:"note"`
	InsertedAt time.Time       `json:"insertedAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	BOMID      uuid.UUID       `json:"bomId"`
	MaterialID uuid.UUID       `json:"materialId"`
	UnitID     uuid.UUID       `json:"unitId"`
}

type HeadCreateInput struct {
	Code string
	Name string
	Note *string
}

type HeadUpdateInput struct {
	Name *string
	Note optional.Optional[string]
}

type BOMCreateInput struct {
	Code       string
	PlanName   *string
	Note       *string
	MaterialID uuid.UUID
}

type BOMUpdateInput struct {
	PlanName optional.Optional[string]
	Note     optional.Optional[string]
}

type RouteItemInput struct {
	Seq          int64
	Requirement  *string
	IsOutsourced bool
	OperationID  uuid.UUID
}

type ComponentInput struct {
	Quantity   decimal.Decimal
	LossRate   *decimal.Decimal
	Note       *string
	BOMID      uuid.UUID
	MaterialID uuid.UUID
	UnitID     uuid.UUID
}

type ByproductInput struct {
	Quantity   decimal.Decimal
	Note       *string
	BOMID      uuid.UUID
	MaterialID uuid.UUID
	UnitID     uuid.UUID
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult[T any] struct {
	Count   int64 `json:"count"`
	Results []T   `json:"results"`
}
