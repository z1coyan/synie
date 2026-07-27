package currency

import (
	"strings"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

func TestValidateCreate(t *testing.T) {
	t.Parallel()
	symbol := " ¥ "
	input := CreateInput{Name: " 人民币 ", ISOCode: "CNY", Symbol: &symbol}
	if err := validateCreate(&input); err != nil {
		t.Fatalf("valid input: %v", err)
	}
	if input.Name != "人民币" || input.Symbol == nil || *input.Symbol != "¥" {
		t.Fatalf("input was not normalized: %#v", input)
	}
}

func TestValidateCreateRejectsBadISOAndLengths(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"cny", "CN", "CNYY", "C1Y"} {
		input := CreateInput{Name: "测试", ISOCode: code}
		err := validateCreate(&input)
		if err == nil {
			t.Fatalf("expected %q to fail", code)
		}
		if got := err.(*apierror.Error).Fields["isoCode"]; len(got) == 0 {
			t.Fatalf("missing isoCode field error for %q", code)
		}
	}

	longName := strings.Repeat("币", 65)
	longSymbol := strings.Repeat("¥", 9)
	input := CreateInput{Name: longName, ISOCode: "TST", Symbol: &longSymbol}
	err := validateCreate(&input).(*apierror.Error)
	if len(err.Fields["name"]) == 0 || len(err.Fields["symbol"]) == 0 {
		t.Fatalf("expected rune-aware length errors, got %#v", err.Fields)
	}
}

func TestValidateUpdateAllowsExplicitSymbolClear(t *testing.T) {
	t.Parallel()
	input := UpdateInput{Symbol: optional.Optional[string]{Set: true, Value: nil}}
	if err := validateUpdate(&input); err != nil {
		t.Fatalf("clear symbol: %v", err)
	}
}
