package settings

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type SalesSetting struct {
	ID                      uuid.UUID       `json:"id"`
	SampleItemMaxQty        int64           `json:"sampleItemMaxQty"`
	DeliveryOvershipRatio   decimal.Decimal `json:"deliveryOvershipRatio"`
	SpotItemMaxQty          int64           `json:"spotItemMaxQty"`
	ReceiptOverreceiveRatio decimal.Decimal `json:"receiptOverreceiveRatio"`
	DemandOverorderRatio    decimal.Decimal `json:"demandOverorderRatio"`
	InsertedAt              time.Time       `json:"insertedAt"`
	UpdatedAt               time.Time       `json:"updatedAt"`
}

type SalesUpdate struct {
	SampleItemMaxQty        *int64
	DeliveryOvershipRatio   *decimal.Decimal
	SpotItemMaxQty          *int64
	ReceiptOverreceiveRatio *decimal.Decimal
	DemandOverorderRatio    *decimal.Decimal
}

type ManufacturingSetting struct {
	ID                     uuid.UUID       `json:"id"`
	OutputOverreceiveRatio decimal.Decimal `json:"outputOverreceiveRatio"`
	InsertedAt             time.Time       `json:"insertedAt"`
	UpdatedAt              time.Time       `json:"updatedAt"`
}

type ManufacturingUpdate struct {
	OutputOverreceiveRatio *decimal.Decimal
}

type AccountingSetting struct {
	ID             uuid.UUID `json:"id"`
	OCRAccessKeyID *string   `json:"ocrAccessKeyId"`
	InsertedAt     time.Time `json:"insertedAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type AccountingUpdate struct {
	OCRAccessKeyID     **string
	OCRAccessKeySecret *string
}

type SystemSetting struct {
	ID                             uuid.UUID  `json:"id"`
	MarketFetchScheduleEnabled     bool       `json:"marketFetchScheduleEnabled"`
	MarketFetchLastIntervalMinutes int        `json:"marketFetchLastIntervalMinutes"`
	MarketFetchSettlementEnabled   bool       `json:"marketFetchSettlementEnabled"`
	MarketFetchLastRunAt           *time.Time `json:"marketFetchLastRunAt"`
	MarketFetchLastSummary         *string    `json:"marketFetchLastSummary"`
	InsertedAt                     time.Time  `json:"insertedAt"`
	UpdatedAt                      time.Time  `json:"updatedAt"`
}

type SystemUpdate struct {
	MarketFetchScheduleEnabled     *bool
	MarketFetchLastIntervalMinutes *int
	MarketFetchSettlementEnabled   *bool
}
