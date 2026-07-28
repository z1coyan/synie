package numbering

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Segment struct {
	Type    string  `json:"type"`
	Value   *string `json:"value,omitempty"`
	Field   *string `json:"field,omitempty"`
	Label   *string `json:"label,omitempty"`
	Format  *string `json:"format,omitempty"`
	Padding *int    `json:"padding,omitempty"`
}

type Rule struct {
	ID         uuid.UUID `json:"id"`
	Resource   string    `json:"resource"`
	Name       string    `json:"name"`
	Segments   []Segment `json:"segments"`
	PerCompany bool      `json:"perCompany"`
	Enabled    bool      `json:"enabled"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type Counter struct {
	ID         uuid.UUID `json:"id"`
	RuleID     uuid.UUID `json:"ruleId"`
	ScopeKey   string    `json:"scopeKey"`
	Value      int64     `json:"value"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateInput struct {
	Resource   string
	Name       string
	Segments   []Segment
	PerCompany *bool
	Enabled    *bool
}

type NextInput struct {
	Resource string
	Values   map[string]any
}

type CounterListQuery struct {
	RuleID *uuid.UUID
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type CounterList struct {
	Count   int64     `json:"count"`
	Results []Counter `json:"results"`
}

type NumberableField struct {
	Path  string `json:"path"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

type NumberableResource struct {
	Prefix string            `json:"prefix"`
	Grid   string            `json:"grid"`
	Fields []NumberableField `json:"fields"`
}

type fieldLookup struct {
	Table       string `json:"table"`
	ValueColumn string `json:"valueColumn"`
}

type catalogField struct {
	Path        string       `json:"path"`
	Label       string       `json:"label"`
	Type        string       `json:"type"`
	SourceField string       `json:"sourceField"`
	Lookup      *fieldLookup `json:"lookup,omitempty"`
}

type catalogResource struct {
	Prefix string         `json:"prefix"`
	Grid   string         `json:"grid"`
	Fields []catalogField `json:"fields"`
	byPath map[string]catalogField
}

func decodeSegments(raw []byte) ([]Segment, error) {
	var segments []Segment
	if err := json.Unmarshal(raw, &segments); err != nil {
		return nil, err
	}
	return segments, nil
}
