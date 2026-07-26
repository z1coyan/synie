package market

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func TestRequiredFieldsAreRejectedBeforeDatabaseAccess(t *testing.T) {
	service := &Service{}

	tests := []struct {
		name   string
		fields []string
		run    func() error
	}{
		{
			name:   "instrument currency and unit",
			fields: []string{"currencyId", "unitId"},
			run: func() error {
				_, err := service.CreateInstrument(context.Background(), nil, InstrumentCreate{
					Code: "CU", Name: "沪铜", SourceType: "EXCHANGE", DefaultPriceKind: "SETTLEMENT",
				})
				return err
			},
		},
		{
			name:   "price point observed time and instrument",
			fields: []string{"observedAt", "instrumentId"},
			run: func() error {
				_, err := service.CreatePricePoint(context.Background(), nil, PricePointCreate{
					Price: decimal.NewFromInt(1),
				})
				return err
			},
		},
		{
			name:   "series time range",
			fields: []string{"from", "to"},
			run: func() error {
				_, err := service.PriceSeries(context.Background(), []uuid.UUID{uuid.New()}, "SETTLEMENT", time.Time{}, time.Time{})
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.run()
			if apierror.Status(err) != 400 {
				t.Fatalf("status = %d, error = %v", apierror.Status(err), err)
			}
			apiErr, ok := err.(*apierror.Error)
			if !ok {
				t.Fatalf("error type = %T", err)
			}
			for _, field := range test.fields {
				if len(apiErr.Fields[field]) == 0 {
					t.Errorf("missing validation detail for %s: %#v", field, apiErr.Fields)
				}
			}
		})
	}
}
