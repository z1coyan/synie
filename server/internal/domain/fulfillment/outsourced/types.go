package outsourced

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type Status string

const (
	StatusDraft   Status = "DRAFT"
	StatusAudited Status = "AUDITED"
	StatusVoided  Status = "VOIDED"
)

type Issue struct {
	ID                    uuid.UUID  `json:"id"`
	IssueNo               string     `json:"issueNo"`
	IssueDate             time.Time  `json:"issueDate"`
	PartyType             string     `json:"partyType"`
	PartyID               uuid.UUID  `json:"partyId"`
	Remarks               *string    `json:"remarks"`
	Status                Status     `json:"status"`
	AuditedAt             *time.Time `json:"auditedAt"`
	InsertedAt            time.Time  `json:"insertedAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	CompanyID             uuid.UUID  `json:"companyId"`
	FromWarehouseID       *uuid.UUID `json:"fromWarehouseId"`
	OutsourcedWarehouseID *uuid.UUID `json:"outsourcedWarehouseId"`
	CreatedByID           *uuid.UUID `json:"createdById"`
	AuditedByID           *uuid.UUID `json:"auditedById"`
}

type IssueItem struct {
	ID                    uuid.UUID       `json:"id"`
	Idx                   int64           `json:"idx"`
	Qty                   decimal.Decimal `json:"qty"`
	BaseQty               decimal.Decimal `json:"baseQty"`
	MaterialCode          string          `json:"materialCode"`
	MaterialName          string          `json:"materialName"`
	MaterialSpec          *string         `json:"materialSpec"`
	UnitName              string          `json:"unitName"`
	OrderNo               string          `json:"orderNo"`
	Remarks               *string         `json:"remarks"`
	InsertedAt            time.Time       `json:"insertedAt"`
	UpdatedAt             time.Time       `json:"updatedAt"`
	IssueID               uuid.UUID       `json:"issueId"`
	CompanyID             uuid.UUID       `json:"companyId"`
	OrderItemMaterialID   uuid.UUID       `json:"orderItemMaterialId"`
	MaterialID            uuid.UUID       `json:"materialId"`
	UnitID                uuid.UUID       `json:"unitId"`
	FromWarehouseID       uuid.UUID       `json:"fromWarehouseId"`
	OutsourcedWarehouseID uuid.UUID       `json:"outsourcedWarehouseId"`
	IssueNo               string          `json:"issueNo"`
	IssueDate             time.Time       `json:"issueDate"`
	IssueStatus           Status          `json:"issueStatus"`
	PartyType             string          `json:"partyType"`
	PartyID               uuid.UUID       `json:"partyId"`
}

type Receipt struct {
	ID                    uuid.UUID  `json:"id"`
	ReceiptNo             string     `json:"receiptNo"`
	ReceiptDate           time.Time  `json:"receiptDate"`
	PostingDate           *time.Time `json:"postingDate"`
	PartyType             string     `json:"partyType"`
	PartyID               uuid.UUID  `json:"partyId"`
	Remarks               *string    `json:"remarks"`
	Status                Status     `json:"status"`
	AuditedAt             *time.Time `json:"auditedAt"`
	InsertedAt            time.Time  `json:"insertedAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	CompanyID             uuid.UUID  `json:"companyId"`
	WarehouseID           *uuid.UUID `json:"warehouseId"`
	OutsourcedWarehouseID *uuid.UUID `json:"outsourcedWarehouseId"`
	DebitAccountID        uuid.UUID  `json:"debitAccountId"`
	CreditAccountID       uuid.UUID  `json:"creditAccountId"`
	CreatedByID           *uuid.UUID `json:"createdById"`
	AuditedByID           *uuid.UUID `json:"auditedById"`
}

type ReceiptItem struct {
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
	ReceiptID                uuid.UUID       `json:"receiptId"`
	CompanyID                uuid.UUID       `json:"companyId"`
	OrderItemID              uuid.UUID       `json:"orderItemId"`
	MaterialID               uuid.UUID       `json:"materialId"`
	UnitID                   uuid.UUID       `json:"unitId"`
	WarehouseID              uuid.UUID       `json:"warehouseId"`
	ReceiptNo                string          `json:"receiptNo"`
	ReceiptDate              time.Time       `json:"receiptDate"`
	ReceiptStatus            Status          `json:"receiptStatus"`
	PartyType                string          `json:"partyType"`
	PartyID                  uuid.UUID       `json:"partyId"`
}

type ReceiptMaterial struct {
	ID                    uuid.UUID       `json:"id"`
	Idx                   int64           `json:"idx"`
	Qty                   decimal.Decimal `json:"qty"`
	BaseQty               decimal.Decimal `json:"baseQty"`
	MaterialCode          string          `json:"materialCode"`
	MaterialName          string          `json:"materialName"`
	MaterialSpec          *string         `json:"materialSpec"`
	UnitName              string          `json:"unitName"`
	OrderNo               string          `json:"orderNo"`
	Remarks               *string         `json:"remarks"`
	InsertedAt            time.Time       `json:"insertedAt"`
	UpdatedAt             time.Time       `json:"updatedAt"`
	ReceiptItemID         uuid.UUID       `json:"receiptItemId"`
	CompanyID             uuid.UUID       `json:"companyId"`
	OrderItemMaterialID   uuid.UUID       `json:"orderItemMaterialId"`
	MaterialID            uuid.UUID       `json:"materialId"`
	UnitID                uuid.UUID       `json:"unitId"`
	OutsourcedWarehouseID *uuid.UUID      `json:"outsourcedWarehouseId"`
	ReceiptNo             string          `json:"receiptNo"`
}

type ReceiptByproduct struct {
	ID                   uuid.UUID       `json:"id"`
	Idx                  int64           `json:"idx"`
	Qty                  decimal.Decimal `json:"qty"`
	BaseQty              decimal.Decimal `json:"baseQty"`
	MaterialCode         string          `json:"materialCode"`
	MaterialName         string          `json:"materialName"`
	MaterialSpec         *string         `json:"materialSpec"`
	UnitName             string          `json:"unitName"`
	OrderNo              string          `json:"orderNo"`
	Remarks              *string         `json:"remarks"`
	InsertedAt           time.Time       `json:"insertedAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
	ReceiptItemID        uuid.UUID       `json:"receiptItemId"`
	CompanyID            uuid.UUID       `json:"companyId"`
	OrderItemByproductID uuid.UUID       `json:"orderItemByproductId"`
	MaterialID           uuid.UUID       `json:"materialId"`
	UnitID               uuid.UUID       `json:"unitId"`
	WarehouseID          *uuid.UUID      `json:"warehouseId"`
	ReceiptNo            string          `json:"receiptNo"`
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult[T any] struct {
	Count   int64 `json:"count"`
	Results []T   `json:"results"`
}

type IssueDetail struct {
	Issue Issue       `json:"issue"`
	Items []IssueItem `json:"items"`
}

type ReceiptItemDetail struct {
	Item       ReceiptItem        `json:"item"`
	Materials  []ReceiptMaterial  `json:"materials"`
	Byproducts []ReceiptByproduct `json:"byproducts"`
}

type ReceiptDetail struct {
	Receipt Receipt             `json:"receipt"`
	Items   []ReceiptItemDetail `json:"items"`
}

type CreateIssueInput struct {
	CompanyID             uuid.UUID
	IssueNo               *string
	IssueDate             *time.Time
	PartyType             string
	PartyID               uuid.UUID
	Remarks               *string
	FromWarehouseID       *uuid.UUID
	OutsourcedWarehouseID *uuid.UUID
}

type UpdateIssueInput struct {
	IssueNo               *string
	IssueDate             *time.Time
	PartyType             *string
	PartyID               *uuid.UUID
	Remarks               **string
	FromWarehouseID       **uuid.UUID
	OutsourcedWarehouseID **uuid.UUID
}

type CreateIssueItemInput struct {
	IssueID               uuid.UUID
	Idx                   int64
	Qty                   decimal.Decimal
	OrderItemMaterialID   uuid.UUID
	FromWarehouseID       *uuid.UUID
	OutsourcedWarehouseID *uuid.UUID
	Remarks               *string
}

type UpdateIssueItemInput struct {
	Idx                   *int64
	Qty                   *decimal.Decimal
	OrderItemMaterialID   *uuid.UUID
	FromWarehouseID       *uuid.UUID
	OutsourcedWarehouseID *uuid.UUID
	Remarks               **string
}

type CreateReceiptInput struct {
	CompanyID             uuid.UUID
	ReceiptNo             *string
	ReceiptDate           *time.Time
	PostingDate           *time.Time
	PartyType             string
	PartyID               uuid.UUID
	Remarks               *string
	WarehouseID           *uuid.UUID
	OutsourcedWarehouseID *uuid.UUID
	DebitAccountID        *uuid.UUID
	CreditAccountID       *uuid.UUID
}

type UpdateReceiptInput struct {
	ReceiptNo             *string
	ReceiptDate           *time.Time
	PostingDate           **time.Time
	PartyType             *string
	PartyID               *uuid.UUID
	Remarks               **string
	WarehouseID           **uuid.UUID
	OutsourcedWarehouseID **uuid.UUID
	DebitAccountID        *uuid.UUID
	CreditAccountID       *uuid.UUID
}

type CreateReceiptItemInput struct {
	ReceiptID   uuid.UUID
	Idx         int64
	Qty         decimal.Decimal
	OrderItemID uuid.UUID
	UnitID      *uuid.UUID
	WarehouseID *uuid.UUID
	Remarks     *string
}

type UpdateReceiptItemInput struct {
	Idx         *int64
	Qty         *decimal.Decimal
	OrderItemID *uuid.UUID
	UnitID      **uuid.UUID
	WarehouseID *uuid.UUID
	Remarks     **string
}

type CreateReceiptMaterialInput struct {
	ReceiptItemID         uuid.UUID
	Idx                   int64
	Qty                   decimal.Decimal
	OrderItemMaterialID   uuid.UUID
	OutsourcedWarehouseID *uuid.UUID
	Remarks               *string
}

type UpdateReceiptMaterialInput struct {
	Idx                   *int64
	Qty                   *decimal.Decimal
	OrderItemMaterialID   *uuid.UUID
	OutsourcedWarehouseID **uuid.UUID
	Remarks               **string
}

type CreateReceiptByproductInput struct {
	ReceiptItemID        uuid.UUID
	Idx                  int64
	Qty                  decimal.Decimal
	OrderItemByproductID uuid.UUID
	WarehouseID          *uuid.UUID
	Remarks              *string
}

type UpdateReceiptByproductInput struct {
	Idx                  *int64
	Qty                  *decimal.Decimal
	OrderItemByproductID *uuid.UUID
	WarehouseID          **uuid.UUID
	Remarks              **string
}

type AuditReceiptInput struct{ PostingDate *time.Time }

type AdjustReconciledQtyInput struct {
	ReceiptItemID uuid.UUID
	Delta         decimal.Decimal
}

type IssueAggregateInput struct {
	Issue CreateIssueInput
	Items []CreateIssueItemInput
}

type ReceiptItemAggregateInput struct {
	Item       CreateReceiptItemInput
	Materials  []CreateReceiptMaterialInput
	Byproducts []CreateReceiptByproductInput
}

type ReceiptAggregateInput struct {
	Receipt CreateReceiptInput
	Items   []ReceiptItemAggregateInput
}
