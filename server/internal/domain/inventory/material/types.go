package material

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Reference struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Code   *string   `json:"code,omitempty"`
	Symbol *string   `json:"symbol,omitempty"`
}

type Material struct {
	ID                 uuid.UUID  `json:"id"`
	Code               string     `json:"code"`
	Name               string     `json:"name"`
	Spec               *string    `json:"spec"`
	CustomerPartNo     *string    `json:"customerPartNo"`
	IsCustomerMaterial bool       `json:"isCustomerMaterial"`
	Active             bool       `json:"active"`
	InsertedAt         time.Time  `json:"insertedAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
	CategoryID         uuid.UUID  `json:"categoryId"`
	DefaultUnitID      uuid.UUID  `json:"defaultUnitId"`
	CustomerID         *uuid.UUID `json:"customerId"`
	Category           Reference  `json:"category"`
	DefaultUnit        Reference  `json:"defaultUnit"`
	Customer           *Reference `json:"customer,omitempty"`
}

type CreateInput struct {
	Name               string
	Spec               *string
	CustomerPartNo     *string
	IsCustomerMaterial *bool
	Active             *bool
	CategoryID         uuid.UUID
	DefaultUnitID      uuid.UUID
	CustomerID         *uuid.UUID
}

type OptionalString struct {
	Set   bool
	Value *string
}

type OptionalUUID struct {
	Set   bool
	Value *uuid.UUID
}

type UpdateInput struct {
	Name               *string
	Spec               OptionalString
	CustomerPartNo     OptionalString
	IsCustomerMaterial *bool
	Active             *bool
	CategoryID         *uuid.UUID
	DefaultUnitID      *uuid.UUID
	CustomerID         OptionalUUID
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type ListResult struct {
	Count   int64      `json:"count"`
	Results []Material `json:"results"`
}
