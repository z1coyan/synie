package customer

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Customer struct {
	ID         uuid.UUID `json:"id"`
	Code       string    `json:"code"`
	Name       string    `json:"name"`
	ShortName  *string   `json:"shortName"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateInput struct {
	Code      string
	Name      string
	ShortName *string
}

type UpdateInput struct {
	Code      *string
	Name      *string
	ShortName optional.Optional[string]
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
	Results []Customer `json:"results"`
}
