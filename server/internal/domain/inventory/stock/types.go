package stock

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

type Line struct {
	WarehouseID uuid.UUID
	MaterialID  uuid.UUID
	Quantity    decimal.Decimal
	Remarks     *string
}

type BalanceQuery struct {
	CompanyID   uuid.UUID
	AsOf        time.Time
	WarehouseID *uuid.UUID
	MaterialID  *uuid.UUID
	HideZero    bool
}

type BalanceRow struct {
	WarehouseID   uuid.UUID       `json:"warehouseId"`
	WarehouseName string          `json:"warehouseName"`
	MaterialID    uuid.UUID       `json:"materialId"`
	MaterialCode  string          `json:"materialCode"`
	MaterialName  string          `json:"materialName"`
	MaterialSpec  *string         `json:"materialSpec"`
	UnitName      string          `json:"unitName"`
	Quantity      decimal.Decimal `json:"quantity"`
}
