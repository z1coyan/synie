package order

import (
	"encoding/json"
	"fmt"
	"strings"
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

func ParseSide(value string) (Side, error) {
	switch Side(strings.ToLower(strings.TrimSpace(value))) {
	case SideSales:
		return SideSales, nil
	case SidePurchase:
		return SidePurchase, nil
	default:
		return "", fmt.Errorf("未知订单方向: %s", value)
	}
}

type Status string

const (
	StatusDraft   Status = "DRAFT"
	StatusAudited Status = "AUDITED"
	StatusClosed  Status = "CLOSED"
	StatusVoided  Status = "VOIDED"
)

type OrderType string

const (
	OrderTypeRegular OrderType = "REGULAR"
	OrderTypeSample  OrderType = "SAMPLE"
	OrderTypeSpot    OrderType = "SPOT"
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

type OrderRef struct {
	ID      uuid.UUID `json:"id"`
	OrderNo string    `json:"orderNo"`
}

type Order struct {
	ID             uuid.UUID       `json:"id"`
	OrderNo        string          `json:"orderNo"`
	OrderDate      time.Time       `json:"orderDate"`
	OrderType      OrderType       `json:"orderType"`
	IsOutsourced   bool            `json:"isOutsourced"`
	PartyType      string          `json:"partyType"`
	PartyID        uuid.UUID       `json:"partyId"`
	ExchangeRate   decimal.Decimal `json:"exchangeRate"`
	Terms          *string         `json:"terms"`
	Remarks        *string         `json:"remarks"`
	Status         Status          `json:"status"`
	AuditedAt      *time.Time      `json:"auditedAt"`
	InsertedAt     time.Time       `json:"insertedAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	CompanyID      uuid.UUID       `json:"companyId"`
	CurrencyID     uuid.UUID       `json:"currencyId"`
	CreatedByID    *uuid.UUID      `json:"createdById"`
	AuditedByID    *uuid.UUID      `json:"auditedById"`
	GrossTotal     decimal.Decimal `json:"grossTotal"`
	BaseGrossTotal decimal.Decimal `json:"baseGrossTotal"`
	Company        NamedRef        `json:"company"`
	Currency       CodeNamedRef    `json:"currency"`
	CreatedBy      *NamedRef       `json:"createdBy"`
	AuditedBy      *NamedRef       `json:"auditedBy"`
}

type Item struct {
	ID                uuid.UUID       `json:"id"`
	Idx               int64           `json:"idx"`
	Qty               decimal.Decimal `json:"qty"`
	BaseQty           decimal.Decimal `json:"baseQty"`
	ShippedQty        decimal.Decimal `json:"shippedQty,omitempty"`
	ReceivedQty       decimal.Decimal `json:"receivedQty,omitempty"`
	Price             decimal.Decimal `json:"price"`
	Amount            decimal.Decimal `json:"amount"`
	BasePrice         decimal.Decimal `json:"basePrice"`
	BaseAmount        decimal.Decimal `json:"baseAmount"`
	TaxRate           decimal.Decimal `json:"taxRate"`
	MaterialCode      string          `json:"materialCode"`
	MaterialName      string          `json:"materialName"`
	MaterialSpec      *string         `json:"materialSpec"`
	CustomerPartNo    *string         `json:"customerPartNo"`
	UnitName          string          `json:"unitName"`
	Remarks           *string         `json:"remarks"`
	DemandDate        *time.Time      `json:"demandDate,omitempty"`
	InsertedAt        time.Time       `json:"insertedAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	OrderID           uuid.UUID       `json:"orderId"`
	CompanyID         uuid.UUID       `json:"companyId"`
	MaterialID        uuid.UUID       `json:"materialId"`
	UnitID            uuid.UUID       `json:"unitId"`
	QuotationItemID   *uuid.UUID      `json:"quotationItemId"`
	PricingMode       *string         `json:"pricingMode,omitempty"`
	BOMID             *uuid.UUID      `json:"bomId,omitempty"`
	BOMCode           *string         `json:"bomCode,omitempty"`
	BOMPlanName       *string         `json:"bomPlanName,omitempty"`
	DemandLineID      *uuid.UUID      `json:"demandLineId,omitempty"`
	DemandNo          *string         `json:"demandNo,omitempty"`
	OrderNo           string          `json:"orderNo"`
	OrderDate         time.Time       `json:"orderDate"`
	OrderStatus       Status          `json:"orderStatus"`
	OrderIsOutsourced bool            `json:"orderIsOutsourced,omitempty"`
	PartyType         string          `json:"partyType"`
	PartyID           uuid.UUID       `json:"partyId"`
	CurrencyCode      string          `json:"currencyCode"`
	RemainingBaseQty  decimal.Decimal `json:"remainingBaseQty"`
	Order             OrderRef        `json:"order"`
	Company           NamedRef        `json:"company"`
	Material          CodeNamedRef    `json:"material"`
	Unit              NamedRef        `json:"unit"`
}

type Material struct {
	ID                uuid.UUID       `json:"id"`
	Quantity          decimal.Decimal `json:"quantity"`
	IssuedQty         decimal.Decimal `json:"issuedQty"`
	Remarks           *string         `json:"remarks"`
	InsertedAt        time.Time       `json:"insertedAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	OrderItemID       uuid.UUID       `json:"orderItemId"`
	CompanyID         uuid.UUID       `json:"companyId"`
	MaterialID        uuid.UUID       `json:"materialId"`
	MaterialCode      string          `json:"materialCode"`
	MaterialName      string          `json:"materialName"`
	MaterialSpec      *string         `json:"materialSpec"`
	UnitID            uuid.UUID       `json:"unitId"`
	UnitName          string          `json:"unitName"`
	OrderNo           string          `json:"orderNo"`
	OrderStatus       Status          `json:"orderStatus"`
	OrderIsOutsourced bool            `json:"orderIsOutsourced"`
	PartyType         string          `json:"partyType"`
	PartyID           uuid.UUID       `json:"partyId"`
	RemainingIssueQty decimal.Decimal `json:"remainingIssueQty"`
}

type Byproduct struct {
	ID           uuid.UUID       `json:"id"`
	Quantity     decimal.Decimal `json:"quantity"`
	Remarks      *string         `json:"remarks"`
	InsertedAt   time.Time       `json:"insertedAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	OrderItemID  uuid.UUID       `json:"orderItemId"`
	CompanyID    uuid.UUID       `json:"companyId"`
	MaterialID   uuid.UUID       `json:"materialId"`
	MaterialCode string          `json:"materialCode"`
	MaterialName string          `json:"materialName"`
	MaterialSpec *string         `json:"materialSpec"`
	UnitID       uuid.UUID       `json:"unitId"`
	UnitName     string          `json:"unitName"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type OrderListResult struct {
	Count   int64   `json:"count"`
	Results []Order `json:"results"`
}

type ItemListResult struct {
	Count   int64  `json:"count"`
	Results []Item `json:"results"`
}

type MaterialListResult struct {
	Count   int64      `json:"count"`
	Results []Material `json:"results"`
}

type ByproductListResult struct {
	Count   int64       `json:"count"`
	Results []Byproduct `json:"results"`
}

type CreateOrderInput struct {
	CompanyID    uuid.UUID
	OrderNo      *string
	OrderDate    *time.Time
	OrderType    OrderType
	IsOutsourced bool
	PartyType    string
	PartyID      uuid.UUID
	CurrencyID   *uuid.UUID
	ExchangeRate *decimal.Decimal
	Terms        *string
	Remarks      *string
}

type UpdateOrderInput struct {
	OrderNo      *string
	OrderDate    *time.Time
	OrderType    *OrderType
	IsOutsourced *bool
	PartyType    *string
	PartyID      *uuid.UUID
	CurrencyID   *uuid.UUID
	ExchangeRate *decimal.Decimal
	Terms        **string
	Remarks      **string
}

type CreateItemInput struct {
	OrderID         uuid.UUID
	Idx             int64
	Qty             decimal.Decimal
	MaterialID      uuid.UUID
	UnitID          uuid.UUID
	Price           *decimal.Decimal
	TaxRate         *decimal.Decimal
	Remarks         *string
	QuotationItemID *uuid.UUID
	BOMID           *uuid.UUID
	DemandLineID    *uuid.UUID
	DemandDate      *time.Time
}

type UpdateItemInput struct {
	Idx             *int64
	Qty             *decimal.Decimal
	MaterialID      *uuid.UUID
	UnitID          *uuid.UUID
	Price           *decimal.Decimal
	TaxRate         *decimal.Decimal
	Remarks         **string
	QuotationItemID **uuid.UUID
	BOMID           **uuid.UUID
	DemandLineID    **uuid.UUID
	DemandDate      **time.Time
}

type CreateMaterialInput struct {
	OrderItemID uuid.UUID
	MaterialID  uuid.UUID
	UnitID      uuid.UUID
	Quantity    decimal.Decimal
	Remarks     *string
}

type UpdateMaterialInput struct {
	MaterialID *uuid.UUID
	UnitID     *uuid.UUID
	Quantity   *decimal.Decimal
	Remarks    **string
}

type CreateByproductInput = CreateMaterialInput
type UpdateByproductInput = UpdateMaterialInput

type DemandPoolQuery struct {
	CompanyID    uuid.UUID
	IsOutsourced bool
	Limit        int
}

type DemandPoolItem struct {
	ID               uuid.UUID       `json:"id"`
	DemandID         uuid.UUID       `json:"demandId"`
	DemandNo         string          `json:"demandNo"`
	Idx              int64           `json:"idx"`
	NeedDate         *time.Time      `json:"needDate"`
	CompanyID        uuid.UUID       `json:"companyId"`
	MaterialID       uuid.UUID       `json:"materialId"`
	UnitID           uuid.UUID       `json:"unitId"`
	MaterialCode     string          `json:"materialCode"`
	MaterialName     string          `json:"materialName"`
	MaterialSpec     *string         `json:"materialSpec"`
	UnitName         string          `json:"unitName"`
	BaseQty          decimal.Decimal `json:"baseQty"`
	OrderedQty       decimal.Decimal `json:"orderedQty"`
	RemainingBaseQty decimal.Decimal `json:"remainingBaseQty"`
	SuggestedQty     decimal.Decimal `json:"suggestedQty"`
}

type BOMPreview struct {
	Materials  []BOMPreviewLine `json:"materials"`
	Byproducts []BOMPreviewLine `json:"byproducts"`
}

type BOMPreviewLine struct {
	MaterialID   uuid.UUID       `json:"materialId"`
	MaterialCode string          `json:"materialCode"`
	MaterialName string          `json:"materialName"`
	UnitID       uuid.UUID       `json:"unitId"`
	UnitName     string          `json:"unitName"`
	Quantity     decimal.Decimal `json:"quantity"`
	Remarks      *string         `json:"remarks"`
}

type FlowItem struct {
	FlowType       string          `json:"flowType"`
	DocumentNo     string          `json:"documentNo"`
	DocumentDate   time.Time       `json:"documentDate"`
	Status         string          `json:"status"`
	CompanyID      uuid.UUID       `json:"companyId"`
	OrderID        uuid.UUID       `json:"orderId"`
	OrderItemID    uuid.UUID       `json:"orderItemId"`
	MaterialCode   string          `json:"materialCode"`
	MaterialName   string          `json:"materialName"`
	MaterialSpec   *string         `json:"materialSpec"`
	CustomerPartNo *string         `json:"customerPartNo"`
	UnitName       string          `json:"unitName"`
	Quantity       decimal.Decimal `json:"quantity"`
}
