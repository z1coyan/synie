package quotation

import (
	"encoding/json"
	"fmt"
	"strings"
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

func ParseSide(value string) (Side, error) {
	switch Side(strings.ToLower(strings.TrimSpace(value))) {
	case SideSales:
		return SideSales, nil
	case SidePurchase:
		return SidePurchase, nil
	default:
		return "", fmt.Errorf("未知报价方向: %s", value)
	}
}

type Status string

const (
	StatusDraft   Status = "DRAFT"
	StatusAudited Status = "AUDITED"
	StatusVoided  Status = "VOIDED"
)

type PricingMode string

const (
	PricingFixed     PricingMode = "FIXED"
	PricingQtyTiered PricingMode = "QTY_TIERED"
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

type QuotationRef struct {
	ID          uuid.UUID `json:"id"`
	QuotationNo string    `json:"quotationNo"`
}

type Quotation struct {
	ID            uuid.UUID    `json:"id"`
	QuotationNo   string       `json:"quotationNo"`
	QuotationDate time.Time    `json:"quotationDate"`
	ValidUntil    time.Time    `json:"validUntil"`
	PartyType     string       `json:"partyType"`
	PartyID       uuid.UUID    `json:"partyId"`
	Terms         *string      `json:"terms"`
	Remarks       *string      `json:"remarks"`
	Status        Status       `json:"status"`
	AuditedAt     *time.Time   `json:"auditedAt"`
	InsertedAt    time.Time    `json:"insertedAt"`
	UpdatedAt     time.Time    `json:"updatedAt"`
	CompanyID     uuid.UUID    `json:"companyId"`
	CurrencyID    uuid.UUID    `json:"currencyId"`
	CreatedByID   *uuid.UUID   `json:"createdById"`
	AuditedByID   *uuid.UUID   `json:"auditedById"`
	Company       NamedRef     `json:"company"`
	Currency      CodeNamedRef `json:"currency"`
	CreatedBy     *NamedRef    `json:"createdBy"`
	AuditedBy     *NamedRef    `json:"auditedBy"`
}

type Item struct {
	ID              uuid.UUID        `json:"id"`
	Idx             int64            `json:"idx"`
	PricingMode     PricingMode      `json:"pricingMode"`
	Price           *decimal.Decimal `json:"price"`
	TaxRate         decimal.Decimal  `json:"taxRate"`
	MaterialCode    string           `json:"materialCode"`
	MaterialName    string           `json:"materialName"`
	MaterialSpec    *string          `json:"materialSpec"`
	CustomerPartNo  *string          `json:"customerPartNo"`
	UnitName        string           `json:"unitName"`
	Remarks         *string          `json:"remarks"`
	InsertedAt      time.Time        `json:"insertedAt"`
	UpdatedAt       time.Time        `json:"updatedAt"`
	QuotationID     uuid.UUID        `json:"quotationId"`
	CompanyID       uuid.UUID        `json:"companyId"`
	MaterialID      uuid.UUID        `json:"materialId"`
	UnitID          uuid.UUID        `json:"unitId"`
	TierCount       int64            `json:"tierCount"`
	QuotationDate   time.Time        `json:"quotationDate"`
	ValidUntil      time.Time        `json:"validUntil"`
	QuotationStatus Status           `json:"quotationStatus"`
	PartyType       string           `json:"partyType"`
	PartyID         uuid.UUID        `json:"partyId"`
	CurrencyCode    string           `json:"currencyCode"`
	Quotation       QuotationRef     `json:"quotation"`
	Company         NamedRef         `json:"company"`
	Material        CodeNamedRef     `json:"material"`
	Unit            NamedRef         `json:"unit"`
}

type Tier struct {
	ID         uuid.UUID       `json:"id"`
	MinQty     decimal.Decimal `json:"minQty"`
	Price      decimal.Decimal `json:"price"`
	InsertedAt time.Time       `json:"insertedAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	ItemID     uuid.UUID       `json:"itemId"`
	CompanyID  uuid.UUID       `json:"companyId"`
	Company    NamedRef        `json:"company"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type QuotationListResult struct {
	Count   int64       `json:"count"`
	Results []Quotation `json:"results"`
}

type ItemListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

type TierListResult struct {
	Count   int64  `json:"count"`
	Results []Tier `json:"results"`
}

type CreateQuotationInput struct {
	CompanyID     uuid.UUID
	QuotationNo   *string
	QuotationDate *time.Time
	ValidUntil    time.Time
	PartyType     string
	PartyID       uuid.UUID
	CurrencyID    *uuid.UUID
	Terms         *string
	Remarks       *string
}

type UpdateQuotationInput struct {
	QuotationNo   *string
	QuotationDate *time.Time
	ValidUntil    *time.Time
	PartyType     *string
	PartyID       *uuid.UUID
	CurrencyID    *uuid.UUID
	Terms         optional.Optional[string]
	Remarks       optional.Optional[string]
}

type CreateItemInput struct {
	QuotationID uuid.UUID
	Idx         int64
	MaterialID  uuid.UUID
	UnitID      uuid.UUID
	PricingMode PricingMode
	Price       *decimal.Decimal
	TaxRate     *decimal.Decimal
	Remarks     *string
}

type UpdateItemInput struct {
	Idx         *int64
	MaterialID  *uuid.UUID
	UnitID      *uuid.UUID
	PricingMode *PricingMode
	Price       optional.Optional[decimal.Decimal]
	TaxRate     *decimal.Decimal
	Remarks     optional.Optional[string]
}

type CreateTierInput struct {
	ItemID uuid.UUID
	MinQty decimal.Decimal
	Price  decimal.Decimal
}

type UpdateTierInput struct {
	MinQty *decimal.Decimal
	Price  *decimal.Decimal
}
