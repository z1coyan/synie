package reconciliation

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Side string

const (
	SideSales    Side = "sales"
	SidePurchase Side = "purchase"
)

type Kind string

const (
	KindRegular    Kind = "regular"
	KindGiftSample Kind = "gift_sample"
)

type Status string

const (
	StatusDraft     Status = "draft"
	StatusConfirmed Status = "confirmed"
	StatusClosed    Status = "closed"
	StatusVoided    Status = "voided"
)

type Head struct {
	ID              uuid.UUID       `json:"id"`
	No              string          `json:"reconciliationNo"`
	Kind            Kind            `json:"reconciliationType"`
	PartyType       string          `json:"partyType"`
	PartyID         uuid.UUID       `json:"partyId"`
	PostingDate     *time.Time      `json:"postingDate"`
	Remarks         *string         `json:"remarks"`
	Status          Status          `json:"status"`
	CompanyID       uuid.UUID       `json:"companyId"`
	DebitAccountID  uuid.UUID       `json:"debitAccountId"`
	CreditAccountID uuid.UUID       `json:"creditAccountId"`
	CreatedByID     *uuid.UUID      `json:"createdById"`
	GrossTotal      decimal.Decimal `json:"grossTotal"`
	BaseGrossTotal  decimal.Decimal `json:"baseGrossTotal"`
	InsertedAt      time.Time       `json:"insertedAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

type Item struct {
	ID                          uuid.UUID       `json:"id"`
	Idx                         int64           `json:"idx"`
	Qty                         decimal.Decimal `json:"qty"`
	BaseQty                     decimal.Decimal `json:"baseQty"`
	Amount                      decimal.Decimal `json:"amount"`
	BaseAmount                  decimal.Decimal `json:"baseAmount"`
	Remarks                     *string         `json:"remarks"`
	ReconciliationID            uuid.UUID       `json:"reconciliationId"`
	CompanyID                   uuid.UUID       `json:"companyId"`
	DeliveryItemID              *uuid.UUID      `json:"deliveryItemId,omitempty"`
	ReceiptItemID               *uuid.UUID      `json:"receiptItemId,omitempty"`
	OutsourcedReceiptItemID     *uuid.UUID      `json:"outsourcedReceiptItemId,omitempty"`
	ReconciliationNo            string          `json:"reconciliationNo"`
	ReconciliationStatus        Status          `json:"reconciliationStatus"`
	SourceNo                    string          `json:"sourceNo"`
	SourceDate                  time.Time       `json:"sourceDate"`
	MaterialName                string          `json:"materialName"`
	UnitName                    string          `json:"unitName"`
	OrderCurrencyCode           string          `json:"orderCurrencyCode"`
	SourceReconciledQty         decimal.Decimal `json:"sourceReconciledQty"`
	SourceRemainingReconcileQty decimal.Decimal `json:"sourceRemainingReconcileQty"`
	InsertedAt                  time.Time       `json:"insertedAt"`
	UpdatedAt                   time.Time       `json:"updatedAt"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type HeadList struct {
	Count   int64  `json:"count"`
	Results []Head `json:"results"`
}

type ItemList struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

type CreateHeadInput struct {
	CompanyID       uuid.UUID
	No              *string
	Kind            Kind
	PartyType       string
	PartyID         uuid.UUID
	DebitAccountID  uuid.UUID
	CreditAccountID uuid.UUID
	Remarks         *string
}

type UpdateHeadInput struct {
	No              *string
	Kind            *Kind
	PartyType       *string
	PartyID         *uuid.UUID
	DebitAccountID  *uuid.UUID
	CreditAccountID *uuid.UUID
	Remarks         **string
}

type CreateItemInput struct {
	ReconciliationID        uuid.UUID
	Idx                     int64
	Qty                     decimal.Decimal
	DeliveryItemID          *uuid.UUID
	ReceiptItemID           *uuid.UUID
	OutsourcedReceiptItemID *uuid.UUID
	Remarks                 *string
}

type UpdateItemInput struct {
	Idx                     *int64
	Qty                     *decimal.Decimal
	DeliveryItemID          **uuid.UUID
	ReceiptItemID           **uuid.UUID
	OutsourcedReceiptItemID **uuid.UUID
	Remarks                 **string
}

type AuditInput struct {
	PostingDate *time.Time
}
