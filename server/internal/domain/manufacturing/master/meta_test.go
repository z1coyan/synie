package master

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaMatchesCapturedGridContracts(t *testing.T) {
	registry := meta.NewRegistry()
	resources := []meta.ResourceMeta{
		OperationResourceMeta(), TemplateResourceMeta(), TemplateItemResourceMeta(),
		BOMResourceMeta(), ComponentResourceMeta(), RouteResourceMeta(), ByproductResourceMeta(),
	}
	for _, resource := range resources {
		registry.MustRegister(resource)
	}
	actors := map[string]*authz.Actor{
		"superadmin": {SuperAdmin: true},
		"read-only": {
			Permissions: map[string]struct{}{
				"mfg.operation:read": {}, "mfg.route_template:read": {}, "mfg.bom:read": {},
			},
		},
	}
	for _, resource := range resources {
		for actorName, actor := range actors {
			t.Run(resource.Name+"/"+actorName, func(t *testing.T) {
				document, err := registry.BuildDocument(resource.Name, actor)
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join("../../../../../.scratch/migration/snapshots/pr-2.17",
					resource.Name+"."+actorName+".grid.json")
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				var expected any
				if err := json.Unmarshal(raw, &expected); err != nil {
					t.Fatal(err)
				}
				actualRaw, err := json.Marshal(document.Grid)
				if err != nil {
					t.Fatal(err)
				}
				var actual any
				if err := json.Unmarshal(actualRaw, &actual); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("GridMeta mismatch\nactual: %s\nexpected: %s", actualRaw, raw)
				}
			})
		}
	}
}
