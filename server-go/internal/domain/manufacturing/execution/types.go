package execution

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type DemandStatus string

const (
	DemandStatusDraft     DemandStatus = "draft"
	DemandStatusConfirmed DemandStatus = "confirmed"
	DemandStatusClosed    DemandStatus = "closed"
	DemandStatusVoided    DemandStatus = "voided"
)

type FulfillmentMethod string

const (
	FulfillmentMake      FulfillmentMethod = "make"
	FulfillmentBuy       FulfillmentMethod = "buy"
	FulfillmentOutsource FulfillmentMethod = "outsource"
	FulfillmentStock     FulfillmentMethod = "stock"
)

type DemandItemStatus string

const (
	DemandItemPending   DemandItemStatus = "pending"
	DemandItemScheduled DemandItemStatus = "scheduled"
	DemandItemCompleted DemandItemStatus = "completed"
)

type WorkOrderStatus string

const (
	WorkOrderInProgress WorkOrderStatus = "in_progress"
	WorkOrderCompleted  WorkOrderStatus = "completed"
	WorkOrderVoided     WorkOrderStatus = "voided"
)

type OutputStatus string

const (
	OutputStatusDraft   OutputStatus = "draft"
	OutputStatusAudited OutputStatus = "audited"
	OutputStatusVoided  OutputStatus = "voided"
)

type Demand struct {
	ID          uuid.UUID    `json:"id"`
	DemandNo    string       `json:"demandNo"`
	DemandDate  time.Time    `json:"demandDate"`
	Remarks     *string      `json:"remarks"`
	Status      DemandStatus `json:"status"`
	CompanyID   uuid.UUID    `json:"companyId"`
	CreatedByID *uuid.UUID   `json:"createdById"`
	InsertedAt  time.Time    `json:"insertedAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

type DemandItem struct {
	ID                 uuid.UUID         `json:"id"`
	DemandID           uuid.UUID         `json:"demandId"`
	CompanyID          uuid.UUID         `json:"companyId"`
	Idx                int64             `json:"idx"`
	MaterialID         uuid.UUID         `json:"materialId"`
	UnitID             uuid.UUID         `json:"unitId"`
	Qty                decimal.Decimal   `json:"qty"`
	BaseQty            decimal.Decimal   `json:"baseQty"`
	OrderedQty         decimal.Decimal   `json:"orderedQty"`
	ReceivedQty        decimal.Decimal   `json:"receivedQty"`
	NeedDate           *time.Time        `json:"needDate"`
	FulfillmentMethod  FulfillmentMethod `json:"fulfillmentMethod"`
	Status             DemandItemStatus  `json:"status"`
	SalesOrderItemID   *uuid.UUID        `json:"salesOrderItemId"`
	MaterialCode       string            `json:"materialCode"`
	MaterialName       string            `json:"materialName"`
	MaterialSpec       *string           `json:"materialSpec"`
	UnitName           string            `json:"unitName"`
	Remarks            *string           `json:"remarks"`
	Ordered            bool              `json:"ordered"`
	RemainingOrderable decimal.Decimal   `json:"remainingOrderableQty"`
	InsertedAt         time.Time         `json:"insertedAt"`
	UpdatedAt          time.Time         `json:"updatedAt"`
}

type WorkOrder struct {
	ID               uuid.UUID       `json:"id"`
	WorkOrderNo      string          `json:"workOrderNo"`
	Qty              decimal.Decimal `json:"qty"`
	BaseQty          decimal.Decimal `json:"baseQty"`
	ReceivedBaseQty  decimal.Decimal `json:"receivedBaseQty"`
	RemainingBaseQty decimal.Decimal `json:"remainingBaseQty"`
	NeedDate         *time.Time      `json:"needDate"`
	MaterialCode     string          `json:"materialCode"`
	MaterialName     string          `json:"materialName"`
	MaterialSpec     *string         `json:"materialSpec"`
	UnitName         string          `json:"unitName"`
	Status           WorkOrderStatus `json:"status"`
	CompanyID        uuid.UUID       `json:"companyId"`
	DemandID         uuid.UUID       `json:"demandId"`
	DemandItemID     uuid.UUID       `json:"demandItemId"`
	MaterialID       uuid.UUID       `json:"materialId"`
	UnitID           uuid.UUID       `json:"unitId"`
	CreatedByID      *uuid.UUID      `json:"createdById"`
	InsertedAt       time.Time       `json:"insertedAt"`
	UpdatedAt        time.Time       `json:"updatedAt"`
}

type Output struct {
	ID          uuid.UUID    `json:"id"`
	OutputNo    string       `json:"outputNo"`
	OutputDate  time.Time    `json:"outputDate"`
	Remarks     *string      `json:"remarks"`
	Status      OutputStatus `json:"status"`
	AuditedAt   *time.Time   `json:"auditedAt"`
	CompanyID   uuid.UUID    `json:"companyId"`
	WarehouseID *uuid.UUID   `json:"warehouseId"`
	CreatedByID *uuid.UUID   `json:"createdById"`
	AuditedByID *uuid.UUID   `json:"auditedById"`
	InsertedAt  time.Time    `json:"insertedAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

type OutputItem struct {
	ID           uuid.UUID       `json:"id"`
	OutputID     uuid.UUID       `json:"outputId"`
	CompanyID    uuid.UUID       `json:"companyId"`
	Idx          int64           `json:"idx"`
	WorkOrderID  uuid.UUID       `json:"workOrderId"`
	MaterialID   uuid.UUID       `json:"materialId"`
	UnitID       uuid.UUID       `json:"unitId"`
	WarehouseID  uuid.UUID       `json:"warehouseId"`
	Qty          decimal.Decimal `json:"qty"`
	BaseQty      decimal.Decimal `json:"baseQty"`
	MaterialCode string          `json:"materialCode"`
	MaterialName string          `json:"materialName"`
	MaterialSpec *string         `json:"materialSpec"`
	UnitName     string          `json:"unitName"`
	Remarks      *string         `json:"remarks"`
	InsertedAt   time.Time       `json:"insertedAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

type CreateDemandInput struct {
	CompanyID  uuid.UUID
	DemandNo   *string
	DemandDate *time.Time
	Remarks    *string
}

type UpdateDemandInput struct {
	DemandNo   *string
	DemandDate *time.Time
	Remarks    optional.Optional[string]
}

type CreateDemandItemInput struct {
	DemandID          uuid.UUID
	Idx               int64
	MaterialID        uuid.UUID
	UnitID            uuid.UUID
	Qty               decimal.Decimal
	NeedDate          *time.Time
	FulfillmentMethod FulfillmentMethod
	SalesOrderItemID  *uuid.UUID
	Remarks           *string
}

type UpdateDemandItemInput struct {
	Idx               *int64
	MaterialID        *uuid.UUID
	UnitID            *uuid.UUID
	Qty               *decimal.Decimal
	NeedDate          optional.Optional[time.Time]
	FulfillmentMethod *FulfillmentMethod
	SalesOrderItemID  optional.Optional[uuid.UUID]
	Remarks           optional.Optional[string]
}

type CreateWorkOrderInput struct {
	DemandItemID uuid.UUID
	WorkOrderNo  *string
}

type UpdateWorkOrderInput struct {
	WorkOrderNo string
}

type CreateOutputInput struct {
	CompanyID   uuid.UUID
	OutputNo    *string
	OutputDate  *time.Time
	WarehouseID *uuid.UUID
	Remarks     *string
}

type UpdateOutputInput struct {
	OutputNo    *string
	OutputDate  *time.Time
	WarehouseID optional.Optional[uuid.UUID]
	Remarks     optional.Optional[string]
}

type CreateOutputItemInput struct {
	OutputID    uuid.UUID
	Idx         int64
	WorkOrderID uuid.UUID
	UnitID      uuid.UUID
	Qty         decimal.Decimal
	WarehouseID uuid.UUID
	Remarks     *string
}

type UpdateOutputItemInput struct {
	Idx         *int64
	WorkOrderID *uuid.UUID
	UnitID      *uuid.UUID
	Qty         *decimal.Decimal
	WarehouseID *uuid.UUID
	Remarks     optional.Optional[string]
}

type ListQuery struct {
	CompanyID *uuid.UUID
	Limit     int
	Offset    int
	Search    string
	Sort      *filterbuild.Sort
	Filter    map[string]json.RawMessage
}

type DemandList struct {
	Count   int64    `json:"count"`
	Results []Demand `json:"results"`
}

type DemandItemList struct {
	Count   int64        `json:"count"`
	Results []DemandItem `json:"results"`
}

type WorkOrderList struct {
	Count   int64       `json:"count"`
	Results []WorkOrder `json:"results"`
}

type OutputList struct {
	Count   int64    `json:"count"`
	Results []Output `json:"results"`
}

type OutputItemList struct {
	Count   int64        `json:"count"`
	Results []OutputItem `json:"results"`
}

type SalesOccupancy struct {
	SalesOrderItemID uuid.UUID       `json:"salesOrderItemId"`
	OrderedBaseQty   decimal.Decimal `json:"orderedBaseQty"`
	OccupiedBaseQty  decimal.Decimal `json:"occupiedBaseQty"`
	RemainingBaseQty decimal.Decimal `json:"remainingBaseQty"`
}
