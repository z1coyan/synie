package warehouse

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Reference struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	Code *string   `json:"code,omitempty"`
}

type Warehouse struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	IsLeaf        bool       `json:"isLeaf"`
	Active        bool       `json:"active"`
	IsOutsourced  bool       `json:"isOutsourced"`
	PartyType     *string    `json:"partyType"`
	PartyID       *uuid.UUID `json:"partyId"`
	AllowNegative bool       `json:"allowNegative"`
	InsertedAt    time.Time  `json:"insertedAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	CompanyID     uuid.UUID  `json:"companyId"`
	ParentID      *uuid.UUID `json:"parentId"`
	AccountID     *uuid.UUID `json:"accountId"`
	Company       Reference  `json:"company"`
	Parent        *Reference `json:"parent,omitempty"`
	Account       *Reference `json:"account,omitempty"`
	HasChildren   bool       `json:"hasChildren"`
}

type CreateInput struct {
	Name          string
	IsLeaf        *bool
	Active        *bool
	IsOutsourced  *bool
	PartyType     *string
	PartyID       *uuid.UUID
	AllowNegative *bool
	CompanyID     uuid.UUID
	ParentID      *uuid.UUID
	AccountID     *uuid.UUID
}

type UpdateInput struct {
	Name          *string
	IsLeaf        *bool
	Active        *bool
	IsOutsourced  *bool
	PartyType     optional.Optional[string]
	PartyID       optional.Optional[uuid.UUID]
	AllowNegative *bool
	ParentID      optional.Optional[uuid.UUID]
	AccountID     optional.Optional[uuid.UUID]
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type ListResult struct {
	Count   int64       `json:"count"`
	Results []Warehouse `json:"results"`
}
