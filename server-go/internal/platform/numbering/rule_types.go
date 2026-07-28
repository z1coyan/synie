package numbering

import (
	"encoding/json"

	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type RuleListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type RuleList struct {
	Count   int64  `json:"count"`
	Results []Rule `json:"results"`
}

type UpdateInput struct {
	Name       *string
	Segments   *[]Segment
	PerCompany *bool
	Enabled    *bool
}
