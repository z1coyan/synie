package unit

import (
	"strings"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func TestNormalizeUnit(t *testing.T) {
	t.Parallel()
	unitType, name, symbol, ratio, err := normalize(" weight ", " 千克 ", " kg ", "0.001", false)
	if err != nil {
		t.Fatal(err)
	}
	if unitType != "weight" || name != "千克" || symbol != "kg" || ratio.String() != "0.001" {
		t.Fatalf("normalized = %q %q %q %s", unitType, name, symbol, ratio)
	}
}

func TestNormalizeUnitRejectsInvalidBusinessRules(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		unitType  string
		unitName  string
		symbol    string
		ratio     string
		isBase    bool
		fieldName string
	}{
		{name: "unknown type", unitType: "volume", unitName: "升", symbol: "L", ratio: "1", fieldName: "unitType"},
		{name: "non-positive ratio", unitType: "quantity", unitName: "件", symbol: "pcs", ratio: "0", fieldName: "ratio"},
		{name: "base ratio", unitType: "length", unitName: "米", symbol: "m", ratio: "1000", isBase: true, fieldName: "ratio"},
		{name: "long name", unitType: "area", unitName: strings.Repeat("面", 33), symbol: "m2", ratio: "1", fieldName: "name"},
		{name: "long symbol", unitType: "area", unitName: "平方米", symbol: strings.Repeat("x", 17), ratio: "1", fieldName: "symbol"},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, _, _, _, err := normalize(tt.unitType, tt.unitName, tt.symbol, tt.ratio, tt.isBase)
			if err == nil {
				t.Fatal("expected validation error")
			}
			appErr, ok := err.(*apierror.Error)
			if !ok || len(appErr.Fields[tt.fieldName]) == 0 {
				t.Fatalf("error = %#v", err)
			}
		})
	}
}
