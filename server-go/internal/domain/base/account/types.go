package account

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
}

type Account struct {
	ID          uuid.UUID  `json:"id"`
	Code        string     `json:"code"`
	Name        string     `json:"name"`
	Direction   string     `json:"direction"`
	IsGroup     bool       `json:"isGroup"`
	Active      bool       `json:"active"`
	Role        *string    `json:"role"`
	ParentID    *uuid.UUID `json:"parentId"`
	CompanyID   uuid.UUID  `json:"companyId"`
	CurrencyID  *uuid.UUID `json:"currencyId"`
	Parent      *Reference `json:"parent,omitempty"`
	Company     Reference  `json:"company"`
	Currency    *Reference `json:"currency,omitempty"`
	HasChildren bool       `json:"hasChildren"`
	InsertedAt  time.Time  `json:"insertedAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type ListResult struct {
	Count   int64     `json:"count"`
	Results []Account `json:"results"`
}

type CreateInput struct {
	Code, Name, Direction string
	IsGroup               bool
	Active                *bool
	Role                  *string
	ParentID              *uuid.UUID
	CompanyID             uuid.UUID
	CurrencyID            *uuid.UUID
}

type UpdateInput struct {
	Name       *string
	Direction  *string
	IsGroup    *bool
	Active     *bool
	Role       optional.Optional[string]
	ParentID   optional.Optional[uuid.UUID]
	CurrencyID optional.Optional[uuid.UUID]
}
