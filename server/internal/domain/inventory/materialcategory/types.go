package materialcategory

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

type MaterialCategory struct {
	ID          uuid.UUID  `json:"id"`
	Code        string     `json:"code"`
	Name        string     `json:"name"`
	IsLeaf      bool       `json:"isLeaf"`
	Active      bool       `json:"active"`
	InsertedAt  time.Time  `json:"insertedAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	ParentID    *uuid.UUID `json:"parentId"`
	Parent      *Reference `json:"parent,omitempty"`
	HasChildren bool       `json:"hasChildren"`
}

type CreateInput struct {
	Code     string
	Name     string
	IsLeaf   *bool
	Active   *bool
	ParentID *uuid.UUID
}

type UpdateInput struct {
	Code     *string
	Name     *string
	IsLeaf   *bool
	Active   *bool
	ParentID **uuid.UUID
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type ListResult struct {
	Count   int64              `json:"count"`
	Results []MaterialCategory `json:"results"`
}
