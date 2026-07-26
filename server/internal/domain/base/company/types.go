package company

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Reference struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type Company struct {
	ID             uuid.UUID  `json:"id"`
	Code           string     `json:"code"`
	Name           string     `json:"name"`
	ShortName      string     `json:"shortName"`
	ParentID       *uuid.UUID `json:"parentId"`
	BaseCurrencyID uuid.UUID  `json:"baseCurrencyId"`
	Parent         *Reference `json:"parent"`
	BaseCurrency   Reference  `json:"baseCurrency"`
	InsertedAt     time.Time  `json:"insertedAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64     `json:"count"`
	Results []Company `json:"results"`
}

type CreateInput struct {
	Code           string
	Name           string
	ShortName      string
	ParentID       *uuid.UUID
	BaseCurrencyID uuid.UUID
}

type UpdateInput struct {
	Name           *string
	ShortName      *string
	ParentID       **uuid.UUID
	BaseCurrencyID *uuid.UUID
}
