package gl

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type Voucher struct {
	Type        string
	ID          uuid.UUID
	No          string
	CompanyID   uuid.UUID
	PostingDate time.Time
}

type VoucherRef struct {
	Type string
	ID   uuid.UUID
}

type Entry struct {
	AccountID  uuid.UUID
	CurrencyID *uuid.UUID
	Debit      decimal.Decimal
	Credit     decimal.Decimal
	PartyType  *string
	PartyID    *uuid.UUID
	Remarks    *string
	IsReversal bool
}

type PostOptions struct {
	AllowNegative bool
}
