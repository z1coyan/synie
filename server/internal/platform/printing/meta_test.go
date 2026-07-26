package printing

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestPrintTemplateGridMetaMatchesCapturedElixirContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/meta/sysPrintTemplates.grid.json")
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
	got, _ := json.Marshal(document.Grid)
	want, _ := json.Marshal(captured)
	if string(got) != string(want) {
		t.Fatalf("Go GridMeta 与 Elixir 捕获不一致:\n got %s\nwant %s", got, want)
	}
}
