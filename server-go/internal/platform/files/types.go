package files

import (
	"encoding/json"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type File struct {
	ID           uuid.UUID
	Storage      string
	Key          string
	Filename     string
	ContentType  *string
	Size         int64
	SHA256       string
	InsertedAt   time.Time
	UploadedByID *uuid.UUID
}

type Attachment struct {
	ID         uuid.UUID
	FileID     uuid.UUID
	OwnerType  string
	OwnerID    uuid.UUID
	Category   string
	CompanyID  *uuid.UUID
	InsertedAt time.Time
	File       *File
}

type UploadInput struct {
	Reader      io.Reader
	Filename    string
	ContentType string
	OwnerType   string
	OwnerID     *uuid.UUID
	Category    string
}

type UploadResult struct {
	File       File
	Attachment *Attachment
}

type AttachInput struct {
	OwnerType string
	OwnerID   uuid.UUID
	Category  string
}

type Download struct {
	Filename    string
	ContentType string
	Content     []byte
	RedirectURL string
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type FileList struct {
	Count   int64
	Results []File
}

type AttachmentQuery struct {
	Limit, Offset int
	FileID        *uuid.UUID
	OwnerType     string
	OwnerID       *uuid.UUID
	Category      string
}

type AttachmentList struct {
	Count   int64
	Results []Attachment
}

type StorageEndpoint struct {
	ID               uuid.UUID
	Name             string
	Label            string
	Kind             string
	Root             *string
	Endpoint         *string
	Region           *string
	Bucket           *string
	Prefix           *string
	AccessKeyID      *string
	SecretConfigured bool
	Builtin          bool
	IsDefault        bool
	InsertedAt       time.Time
	UpdatedAt        time.Time
}

type StorageCreateInput struct {
	Name, Label     string
	Kind            string
	Root            *string
	Endpoint        *string
	Region          *string
	Bucket          *string
	Prefix          *string
	AccessKeyID     *string
	SecretAccessKey *string
}

type StorageUpdateInput struct {
	Label           *string
	Root            **string
	Endpoint        **string
	Region          **string
	Bucket          **string
	Prefix          **string
	AccessKeyID     **string
	SecretAccessKey *string
}

type StorageList struct {
	Count   int64
	Results []StorageEndpoint
}
