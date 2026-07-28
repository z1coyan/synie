package currency

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaBuildsPermissionFilteredDocument(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(ResourceMeta())
	doc, err := registry.BuildDocument(ResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(doc.Grid.Capabilities, []string{"create", "update", "delete"}) {
		t.Fatalf("capabilities = %#v", doc.Grid.Capabilities)
	}
	if doc.Form == nil || !slices.Contains(doc.Form.Exclude, "active") {
		t.Fatalf("active must be excluded from forms: %#v", doc.Form)
	}
	if len(doc.Grid.Columns) != 7 || doc.Grid.Columns[2].Name != "isoCode" {
		t.Fatalf("unexpected wire columns: %#v", doc.Grid.Columns)
	}
}

func TestResourceMetaMatchesCapturedElixirGridContract(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("testdata/meta/basCurrencies.grid.json")
	if err != nil {
		t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
	}
	var captured meta.GridMetaDTO
	if err := json.Unmarshal(raw, &captured); err != nil {
		t.Fatal(err)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(ResourceMeta())
	document, err := registry.BuildDocument(ResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(document.Grid, captured) {
		got, _ := json.MarshalIndent(document.Grid, "", "  ")
		t.Fatalf("Go GridMeta 与 Elixir 捕获不一致:\n%s", got)
	}
}
