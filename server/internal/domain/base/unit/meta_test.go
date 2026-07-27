package unit

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaMatchesCapturedElixirGridContract(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("testdata/meta/basUnits.grid.json")
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

func TestResourceMetaPreservesFormAndPermissionContract(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(ResourceMeta())
	actor := &authz.Actor{Permissions: map[string]struct{}{
		"base.unit:read":   {},
		"base.unit:create": {},
	}}
	document, err := registry.BuildDocument(ResourceName, actor)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(document.Grid.Capabilities, []string{"create"}) {
		t.Fatalf("capabilities = %#v", document.Grid.Capabilities)
	}
	if document.Form == nil || !slices.Equal(document.Form.Exclude, []string{"id", "insertedAt", "updatedAt"}) {
		t.Fatalf("form = %#v", document.Form)
	}
	if document.Grid.Columns[1].Name != "unitType" || len(document.Grid.Columns[1].EnumOptions) != 4 {
		t.Fatalf("unit type enum = %#v", document.Grid.Columns[1])
	}
}
