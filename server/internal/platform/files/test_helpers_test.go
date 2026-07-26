package files

import (
	"encoding/json"
	"testing"
)

func ptr(value string) *string { return &value }

func toJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
