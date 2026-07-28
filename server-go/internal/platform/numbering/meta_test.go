package numbering

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestNumberingGridMetaMatchesCapturedElixirContracts(t *testing.T) {
	registry := meta.NewRegistry()
	registry.MustRegister(RuleResourceMeta())
	registry.MustRegister(CounterResourceMeta())
	actor := &authz.Actor{SuperAdmin: true}
	cases := []struct {
		name string
		path string
	}{
		{name: RuleResourceName, path: "testdata/meta/sysNumberingRules.grid.json"},
		{name: CounterResourceName, path: "testdata/meta/sysNumberingCounters.grid.json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := os.ReadFile(tc.path)
			if err != nil {
				t.Fatal(err)
			}
			var captured meta.GridMetaDTO
			if err := json.Unmarshal(raw, &captured); err != nil {
				t.Fatal(err)
			}
			document, err := registry.BuildDocument(tc.name, actor)
			if err != nil {
				t.Fatal(err)
			}
			got, _ := json.Marshal(document.Grid)
			want, _ := json.Marshal(captured)
			if string(got) != string(want) {
				t.Fatalf("Go GridMeta 与 Elixir 捕获不一致:\n got %s\nwant %s", got, want)
			}
		})
	}
}

func TestCounterDoesNotCreateDuplicatePermissionActions(t *testing.T) {
	registry := meta.NewRegistry()
	registry.MustRegister(RuleResourceMeta())
	registry.MustRegister(CounterResourceMeta())
	catalog := registry.PermissionCatalog()
	if len(catalog) != 1 || catalog[0].Prefix != "sys.numbering_rule" ||
		len(catalog[0].Actions) != 4 {
		t.Fatalf("permission catalog = %#v", catalog)
	}
}
