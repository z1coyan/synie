package companyaccountdefault

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type CompanyAccountDefault struct {
	ID                      uuid.UUID  `json:"id"`
	CompanyID               uuid.UUID  `json:"companyId"`
	DeliveryDebitAccountID  *uuid.UUID `json:"deliveryDebitAccountId"`
	DeliveryCreditAccountID *uuid.UUID `json:"deliveryCreditAccountId"`
	ReceiptDebitAccountID   *uuid.UUID `json:"receiptDebitAccountId"`
	ReceiptCreditAccountID  *uuid.UUID `json:"receiptCreditAccountId"`
	InsertedAt              time.Time  `json:"insertedAt"`
	UpdatedAt               time.Time  `json:"updatedAt"`
}

type CreateInput struct {
	CompanyID               uuid.UUID
	DeliveryDebitAccountID  *uuid.UUID
	DeliveryCreditAccountID *uuid.UUID
	ReceiptDebitAccountID   *uuid.UUID
	ReceiptCreditAccountID  *uuid.UUID
}

type UpdateInput struct {
	DeliveryDebitAccountID  optional.Optional[uuid.UUID]
	DeliveryCreditAccountID optional.Optional[uuid.UUID]
	ReceiptDebitAccountID   optional.Optional[uuid.UUID]
	ReceiptCreditAccountID  optional.Optional[uuid.UUID]
}

type ListQuery struct {
	Limit  int
	Offset int
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64                   `json:"count"`
	Results []CompanyAccountDefault `json:"results"`
}
