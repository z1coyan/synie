package glentry

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Entry struct {
	ID          uuid.UUID       `json:"id"`
	Seq         int64           `json:"seq"`
	PostingDate time.Time       `json:"postingDate"`
	Debit       decimal.Decimal `json:"debit"`
	Credit      decimal.Decimal `json:"credit"`
	PartyType   *string         `json:"partyType"`
	PartyID     *uuid.UUID      `json:"partyId"`
	VoucherType string          `json:"voucherType"`
	VoucherID   uuid.UUID       `json:"voucherId"`
	VoucherNo   string          `json:"voucherNo"`
	IsCancelled bool            `json:"isCancelled"`
	IsReversed  bool            `json:"isReversed"`
	IsReversal  bool            `json:"isReversal"`
	Remarks     *string         `json:"remarks"`
	InsertedAt  time.Time       `json:"insertedAt"`
	CompanyID   uuid.UUID       `json:"companyId"`
	AccountID   uuid.UUID       `json:"accountId"`
	CurrencyID  *uuid.UUID      `json:"currencyId"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64   `json:"count"`
	Results []Entry `json:"results"`
}

type ReportQuery struct {
	CompanyID uuid.UUID
	AsOf      time.Time
}

type RoleAccount struct {
	ID   uuid.UUID `json:"id"`
	Code string    `json:"code"`
	Name string    `json:"name"`
}

type ReportRow struct {
	PartyType     *string                    `json:"partyType"`
	PartyID       *uuid.UUID                 `json:"partyId"`
	PartyLabel    string                     `json:"partyLabel"`
	Balances      map[string]decimal.Decimal `json:"balances"`
	NetReceivable decimal.Decimal            `json:"netReceivable"`
	NetPayable    decimal.Decimal            `json:"netPayable"`
}

type Report struct {
	AsOf         string                   `json:"asOf"`
	RoleAccounts map[string][]RoleAccount `json:"roleAccounts"`
	Rows         []ReportRow              `json:"rows"`
}
