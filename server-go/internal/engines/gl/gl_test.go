package gl

import (
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func TestValidateShape(t *testing.T) {
	accountID := uuid.New()
	valid := []Entry{
		{AccountID: accountID, Debit: decimal.NewFromInt(10)},
		{AccountID: accountID, Credit: decimal.NewFromInt(10)},
	}
	if err := validateShape(valid, false); err != nil {
		t.Fatalf("valid entries: %v", err)
	}
	cases := []struct {
		name    string
		entries []Entry
	}{
		{"one row", valid[:1]},
		{"both zero", []Entry{{AccountID: accountID}, {AccountID: accountID}}},
		{"both sides", []Entry{
			{AccountID: accountID, Debit: decimal.NewFromInt(1), Credit: decimal.NewFromInt(1)},
			{AccountID: accountID, Credit: decimal.NewFromInt(1)},
		}},
		{"unbalanced", []Entry{
			{AccountID: accountID, Debit: decimal.NewFromInt(2)},
			{AccountID: accountID, Credit: decimal.NewFromInt(1)},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateShape(tc.entries, false); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateShapeAllowsNegativeOnlyForReversal(t *testing.T) {
	accountID := uuid.New()
	entries := []Entry{
		{AccountID: accountID, Debit: decimal.NewFromInt(-10), IsReversal: true},
		{AccountID: accountID, Credit: decimal.NewFromInt(-10), IsReversal: true},
	}
	if err := validateShape(entries, false); err == nil {
		t.Fatal("normal posting accepted negative amounts")
	}
	if err := validateShape(entries, true); err != nil {
		t.Fatalf("reversal entries: %v", err)
	}
}
