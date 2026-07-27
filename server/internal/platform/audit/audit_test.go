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

func TestFilterSensitiveRedactsDeclaredFieldsAcrossChangeShapes(t *testing.T) {
	t.Parallel()
	sensitive := []string{"secret"}
	snapshot := map[string]any{"name": "甲", "secret": "s3cr3t"}

	created := FilterSensitive(Created(snapshot, []string{"name", "secret"}), sensitive)
	if created["secret"]["to"] != FilteredPlaceholder {
		t.Fatalf("created secret = %#v", created["secret"])
	}
	if _, ok := created["secret"]["from"]; ok {
		t.Fatalf("created 不应出现 from 键: %#v", created["secret"])
	}
	if created["name"]["to"] != "甲" {
		t.Fatalf("非敏感字段不应受影响: %#v", created["name"])
	}

	destroyed := FilterSensitive(Destroyed(snapshot, []string{"name", "secret"}), sensitive)
	if destroyed["secret"]["from"] != FilteredPlaceholder {
		t.Fatalf("destroyed secret = %#v", destroyed["secret"])
	}
	if _, ok := destroyed["secret"]["to"]; ok {
		t.Fatalf("destroyed 不应出现 to 键: %#v", destroyed["secret"])
	}
	if destroyed["name"]["from"] != "甲" {
		t.Fatalf("非敏感字段不应受影响: %#v", destroyed["name"])
	}

	diff := FilterSensitive(Diff(
		map[string]any{"name": "甲", "secret": "old-secret"},
		map[string]any{"name": "甲", "secret": "new-secret"},
		[]string{"name", "secret"},
	), sensitive)
	if len(diff) != 1 {
		t.Fatalf("diff 应只含变化字段: %#v", diff)
	}
	if diff["secret"]["from"] != FilteredPlaceholder || diff["secret"]["to"] != FilteredPlaceholder {
		t.Fatalf("diff secret = %#v", diff["secret"])
	}
}

func TestFilterSensitiveWithoutDeclarationKeepsValues(t *testing.T) {
	t.Parallel()
	changes := Diff(
		map[string]any{"secret": "old-secret"},
		map[string]any{"secret": "new-secret"},
		[]string{"secret"},
	)
	if got := FilterSensitive(changes, nil); got["secret"]["from"] != "old-secret" || got["secret"]["to"] != "new-secret" {
		t.Fatalf("未声明敏感字段时行为不应变化: %#v", got)
	}
	if got := FilterSensitive(changes, []string{"other"}); got["secret"]["to"] != "new-secret" {
		t.Fatalf("未命中的声明不应脱敏: %#v", got)
	}
}

func TestFilterSensitiveDoesNotMutateInput(t *testing.T) {
	t.Parallel()
	changes := map[string]Change{"secret": {"from": "old-secret", "to": "new-secret"}}
	filtered := FilterSensitive(changes, []string{"secret"})
	if filtered["secret"]["from"] != FilteredPlaceholder {
		t.Fatalf("filtered = %#v", filtered["secret"])
	}
	if changes["secret"]["from"] != "old-secret" || changes["secret"]["to"] != "new-secret" {
		t.Fatalf("输入被修改: %#v", changes["secret"])
	}
}
