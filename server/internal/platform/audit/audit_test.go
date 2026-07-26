package audit

import (
	"encoding/json"
	"testing"
)

func TestAuditChangeShapesMatchExistingLogs(t *testing.T) {
	t.Parallel()
	snapshot := map[string]any{"name": "美元", "symbol": nil}
	created, err := json.Marshal(Created(snapshot, []string{"name", "symbol"}))
	if err != nil {
		t.Fatal(err)
	}
	if string(created) != `{"name":{"to":"美元"},"symbol":{"to":null}}` {
		t.Fatalf("created = %s", created)
	}
	destroyed, err := json.Marshal(Destroyed(snapshot, []string{"name", "symbol"}))
	if err != nil {
		t.Fatal(err)
	}
	if string(destroyed) != `{"name":{"from":"美元"},"symbol":{"from":null}}` {
		t.Fatalf("destroyed = %s", destroyed)
	}
}

func TestDiffOnlyIncludesActualChanges(t *testing.T) {
	t.Parallel()
	changes := Diff(
		map[string]any{"name": "美元", "active": true},
		map[string]any{"name": "美金", "active": true},
		[]string{"name", "active"},
	)
	if len(changes) != 1 || changes["name"]["from"] != "美元" || changes["name"]["to"] != "美金" {
		t.Fatalf("changes = %#v", changes)
	}
}
