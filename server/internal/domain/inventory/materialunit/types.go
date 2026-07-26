package materialunit

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Reference struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Symbol *string   `json:"symbol,omitempty"`
}

type MaterialUnit struct {
	ID         uuid.UUID `json:"id"`
	Factor     string    `json:"factor"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	MaterialID uuid.UUID `json:"materialId"`
	UnitID     uuid.UUID `json:"unitId"`
	Material   Reference `json:"material"`
	Unit       Reference `json:"unit"`
}

type CreateInput struct {
	MaterialID uuid.UUID
	UnitID     uuid.UUID
	Factor     string
}

type UpdateInput struct {
	UnitID *uuid.UUID
	Factor *string
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type ListResult struct {
	Count   int64          `json:"count"`
	Results []MaterialUnit `json:"results"`
}
