package currency

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Currency struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	ISOCode    string    `json:"isoCode"`
	Symbol     *string   `json:"symbol"`
	Active     bool      `json:"active"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateInput struct {
	Name    string
	ISOCode string
	Symbol  *string
	Active  *bool
}

type OptionalString struct {
	Set   bool
	Value *string
}

type UpdateInput struct {
	Name   *string
	Symbol OptionalString
	Active *bool
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
	Results []Currency `json:"results"`
}
