package gljournal

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Status string

const (
	StatusDraft     Status = "DRAFT"
	StatusAudited   Status = "AUDITED"
	StatusCancelled Status = "CANCELLED"
)

type NamedRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type CodeNamedRef struct {
	ID   uuid.UUID `json:"id"`
	Code string    `json:"code"`
	Name string    `json:"name"`
}

type JournalRef struct {
	ID        uuid.UUID `json:"id"`
	VoucherNo string    `json:"voucherNo"`
}

type Journal struct {
	ID            uuid.UUID       `json:"id"`
	VoucherNo     string          `json:"voucherNo"`
	Date          time.Time       `json:"date"`
	PostingDate   *time.Time      `json:"postingDate"`
	Remarks       *string         `json:"remarks"`
	Status        Status          `json:"status"`
	SubmittedAt   *time.Time      `json:"submittedAt"`
	InsertedAt    time.Time       `json:"insertedAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	CompanyID     uuid.UUID       `json:"companyId"`
	CreatedByID   *uuid.UUID      `json:"createdById"`
	SubmittedByID *uuid.UUID      `json:"submittedById"`
	DebitTotal    decimal.Decimal `json:"debitTotal"`
	CreditTotal   decimal.Decimal `json:"creditTotal"`
	Company       NamedRef        `json:"company"`
	CreatedBy     *NamedRef       `json:"createdBy"`
	SubmittedBy   *NamedRef       `json:"submittedBy"`
}

type Line struct {
	ID         uuid.UUID       `json:"id"`
	Idx        int64           `json:"idx"`
	Debit      decimal.Decimal `json:"debit"`
	Credit     decimal.Decimal `json:"credit"`
	PartyType  *string         `json:"partyType"`
	PartyID    *uuid.UUID      `json:"partyId"`
	Remarks    *string         `json:"remarks"`
	InsertedAt time.Time       `json:"insertedAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	JournalID  uuid.UUID       `json:"journalId"`
	CompanyID  uuid.UUID       `json:"companyId"`
	AccountID  uuid.UUID       `json:"accountId"`
	CurrencyID *uuid.UUID      `json:"currencyId"`
	Journal    JournalRef      `json:"journal"`
	Company    NamedRef        `json:"company"`
	Account    CodeNamedRef    `json:"account"`
	Currency   *CodeNamedRef   `json:"currency"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64     `json:"count"`
	Results []Journal `json:"results"`
}

type ListLineQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type LineListResult struct {
	Count   int64  `json:"count"`
	Results []Line `json:"results"`
}

type CreateInput struct {
	VoucherNo   *string
	Date        time.Time
	PostingDate *time.Time
	Remarks     *string
	CompanyID   uuid.UUID
}

type UpdateInput struct {
	VoucherNo   *string
	Date        *time.Time
	PostingDate optional.Optional[time.Time]
	Remarks     optional.Optional[string]
}

type CreateLineInput struct {
	JournalID uuid.UUID
	Idx       int64
	AccountID uuid.UUID
	Debit     decimal.Decimal
	Credit    decimal.Decimal
	PartyType *string
	PartyID   *uuid.UUID
	Remarks   *string
}

type UpdateLineInput struct {
	Idx       *int64
	AccountID *uuid.UUID
	Debit     *decimal.Decimal
	Credit    *decimal.Decimal
	PartyType optional.Optional[string]
	PartyID   optional.Optional[uuid.UUID]
	Remarks   optional.Optional[string]
}
