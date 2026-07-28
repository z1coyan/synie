package account

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
	raw, err := os.ReadFile("testdata/meta/basAccounts.grid.json")
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
		"base.account:read":   {},
		"base.account:create": {},
	}}
	document, err := registry.BuildDocument(ResourceName, actor)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(document.Grid.Capabilities, []string{"create"}) {
		t.Fatalf("capabilities = %#v", document.Grid.Capabilities)
	}
	if document.Form == nil || document.Form.Fields["code"]["edit"] != "createOnly" {
		t.Fatalf("form = %#v", document.Form)
	}
	if got := len(document.Grid.Columns[6].EnumOptions); got != 12 {
		t.Fatalf("role enum count = %d", got)
	}
}
