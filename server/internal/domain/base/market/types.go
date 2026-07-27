package market

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Instrument struct {
	ID                                           uuid.UUID
	Code, Name, SourceType                       string
	DefaultPriceKind                             string
	Active, FetchEnabled                         bool
	ExternalLastCode, ExternalProductGroup, Note *string
	CurrencyID, UnitID                           uuid.UUID
	InsertedAt, UpdatedAt                        time.Time
}

type PricePoint struct {
	ID                               uuid.UUID
	ObservedAt                       time.Time
	Price                            decimal.Decimal
	PriceKind, Source                string
	IsVoided                         bool
	Note                             *string
	InstrumentID, CurrencyID, UnitID uuid.UUID
	InsertedAt, UpdatedAt            time.Time
}

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type InstrumentList struct {
	Count   int64
	Results []Instrument
}

type PricePointList struct {
	Count   int64
	Results []PricePoint
}

type InstrumentCreate struct {
	Code, Name, SourceType, DefaultPriceKind     string
	Active, FetchEnabled                         *bool
	ExternalLastCode, ExternalProductGroup, Note *string
	CurrencyID, UnitID                           uuid.UUID
}

type InstrumentUpdate struct {
	Name, DefaultPriceKind                       *string
	Active, FetchEnabled                         *bool
	ExternalLastCode, ExternalProductGroup, Note optional.Optional[string]
}

type PricePointCreate struct {
	ObservedAt   time.Time
	Price        decimal.Decimal
	PriceKind    *string
	Source       *string
	Note         *string
	InstrumentID uuid.UUID
}

type ChartInstrument struct {
	ID, InstrumentID       uuid.UUID
	Code, Name             string
	CurrencyID, UnitID     uuid.UUID
	CurrencyCode, UnitName *string
	DefaultPriceKind       string
}

type SeriesPoint struct {
	ObservedAt time.Time
	Price      decimal.Decimal
}

type InstrumentSeries struct {
	ChartInstrument
	Points []SeriesPoint
}

type PriceSeries struct {
	PriceKind string
	From, To  time.Time
	Series    []InstrumentSeries
}
