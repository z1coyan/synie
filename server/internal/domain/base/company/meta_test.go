package company

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaMatchesCapturedElixirGridContract(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../../contracts/meta/basCompanies.grid.json")
	if err != nil {
		t.Fatal(err)
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
