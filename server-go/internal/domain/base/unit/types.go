package unit

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Unit struct {
	ID                    uuid.UUID
	UnitType              string
	IsBase                bool
	Name, Symbol          string
	Ratio                 decimal.Decimal
	InsertedAt, UpdatedAt time.Time
}
type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}
type ListResult struct {
	Count   int64
	Results []Unit
}
type CreateInput struct {
	UnitType            string
	IsBase              *bool
	Name, Symbol, Ratio string
}
type UpdateInput struct {
	UnitType            *string
	IsBase              *bool
	Name, Symbol, Ratio *string
}
