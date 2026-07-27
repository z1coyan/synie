package standard

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Side string

const (
	SideSales    Side = "sales"
	SidePurchase Side = "purchase"
)

type Status string

const (
	StatusDraft   Status = "DRAFT"
	StatusAudited Status = "AUDITED"
	StatusVoided  Status = "VOIDED"
)

type Head struct {
	ID              uuid.UUID  `json:"id"`
	No              string     `json:"no"`
	DocumentDate    time.Time  `json:"documentDate"`
	PostingDate     *time.Time `json:"postingDate"`
	PartyType       string     `json:"partyType"`
	PartyID         uuid.UUID  `json:"partyId"`
	Remarks         *string    `json:"remarks"`
	Status          Status     `json:"status"`
	AuditedAt       *time.Time `json:"auditedAt"`
	InsertedAt      time.Time  `json:"insertedAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	CompanyID       uuid.UUID  `json:"companyId"`
	WarehouseID     *uuid.UUID `json:"warehouseId"`
	DebitAccountID  uuid.UUID  `json:"debitAccountId"`
	CreditAccountID uuid.UUID  `json:"creditAccountId"`
	CreatedByID     *uuid.UUID `json:"createdById"`
	AuditedByID     *uuid.UUID `json:"auditedById"`
}

type Item struct {
	ID                       uuid.UUID       `json:"id"`
	Idx                      int64           `json:"idx"`
	Qty                      decimal.Decimal `json:"qty"`
	BaseQty                  decimal.Decimal `json:"baseQty"`
	MaterialCode             string          `json:"materialCode"`
	MaterialName             string          `json:"materialName"`
	MaterialSpec             *string         `json:"materialSpec"`
	CustomerPartNo           *string         `json:"customerPartNo"`
	UnitName                 string          `json:"unitName"`
	OrderNo                  string          `json:"orderNo"`
	OrderQty                 decimal.Decimal `json:"orderQty"`
	OrderBaseQty             decimal.Decimal `json:"orderBaseQty"`
	OrderUnitName            string          `json:"orderUnitName"`
	OrderPrice               decimal.Decimal `json:"orderPrice"`
	OrderAmount              decimal.Decimal `json:"orderAmount"`
	OrderBasePrice           decimal.Decimal `json:"orderBasePrice"`
	OrderBaseAmount          decimal.Decimal `json:"orderBaseAmount"`
	OrderTaxRate             decimal.Decimal `json:"orderTaxRate"`
	OrderCurrencyCode        string          `json:"orderCurrencyCode"`
	ReconciledQty            decimal.Decimal `json:"reconciledQty"`
	RemainingReconcilableQty decimal.Decimal `json:"remainingReconcilableQty"`
	Remarks                  *string         `json:"remarks"`
	InsertedAt               time.Time       `json:"insertedAt"`
	UpdatedAt                time.Time       `json:"updatedAt"`
	HeadID                   uuid.UUID       `json:"headId"`
	CompanyID                uuid.UUID       `json:"companyId"`
	OrderItemID              uuid.UUID       `json:"orderItemId"`
	MaterialID               uuid.UUID       `json:"materialId"`
	UnitID                   uuid.UUID       `json:"unitId"`
	WarehouseID              uuid.UUID       `json:"warehouseId"`
	HeadNo                   string          `json:"headNo"`
	HeadDate                 time.Time       `json:"headDate"`
	HeadStatus               Status          `json:"headStatus"`
	PartyType                string          `json:"partyType"`
	PartyID                  uuid.UUID       `json:"partyId"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type HeadListResult struct {
	Count   int64  `json:"count"`
	Results []Head `json:"results"`
}

type ItemListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

type CreateHeadInput struct {
	CompanyID       uuid.UUID
	No              *string
	DocumentDate    *time.Time
	PostingDate     *time.Time
	PartyType       string
	PartyID         uuid.UUID
	Remarks         *string
	WarehouseID     *uuid.UUID
	DebitAccountID  uuid.UUID
	CreditAccountID uuid.UUID
}

type UpdateHeadInput struct {
	No              *string
	DocumentDate    *time.Time
	PostingDate     optional.Optional[time.Time]
	PartyType       *string
	PartyID         *uuid.UUID
	Remarks         optional.Optional[string]
	WarehouseID     optional.Optional[uuid.UUID]
	DebitAccountID  *uuid.UUID
	CreditAccountID *uuid.UUID
}

type CreateItemInput struct {
	HeadID      uuid.UUID
	Idx         int64
	Qty         decimal.Decimal
	OrderItemID uuid.UUID
	UnitID      *uuid.UUID
	WarehouseID uuid.UUID
	Remarks     *string
}

type UpdateItemInput struct {
	Idx         *int64
	Qty         *decimal.Decimal
	OrderItemID *uuid.UUID
	UnitID      optional.Optional[uuid.UUID]
	WarehouseID *uuid.UUID
	Remarks     optional.Optional[string]
}

// CompanyAccountDefaults is a read-only dependency seam used by fulfillment
// create forms. salCompanyAccountDefaults remains a separately counted
// resource; this DTO does not expose its CRUD surface.
type CompanyAccountDefaults struct {
	ID                      *uuid.UUID `json:"id"`
	CompanyID               uuid.UUID  `json:"companyId"`
	DeliveryDebitAccountID  *uuid.UUID `json:"deliveryDebitAccountId"`
	DeliveryCreditAccountID *uuid.UUID `json:"deliveryCreditAccountId"`
	ReceiptDebitAccountID   *uuid.UUID `json:"receiptDebitAccountId"`
	ReceiptCreditAccountID  *uuid.UUID `json:"receiptCreditAccountId"`
}
