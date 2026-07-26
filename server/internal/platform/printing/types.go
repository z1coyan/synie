package printing

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/files"
)

type Template struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Resource   string    `json:"resource"`
	IsDefault  bool      `json:"isDefault"`
	Remarks    *string   `json:"remarks"`
	FileID     uuid.UUID `json:"fileId"`
	InsertedAt time.Time `json:"insertedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type CreateInput struct {
	Name     string
	Resource string
	FileID   uuid.UUID
	Remarks  *string
}

type UpdateInput struct {
	Name    *string
	FileID  *uuid.UUID
	Remarks **string
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type TemplateList struct {
	Count   int64      `json:"count"`
	Results []Template `json:"results"`
}

type StoredFileReader interface {
	ReadStoredFile(context.Context, uuid.UUID) (files.File, []byte, error)
}
