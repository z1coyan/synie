package execution

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaMatchesPR217Snapshots(t *testing.T) {
	resources := []meta.ResourceMeta{
		DemandResourceMeta(),
		DemandItemResourceMeta(),
		WorkOrderResourceMeta(),
		OutputResourceMeta(),
		OutputItemResourceMeta(),
	}
	for _, resource := range resources {
		resource := resource
		t.Run(resource.Name, func(t *testing.T) {
			for _, role := range []string{"superadmin", "read-only"} {
				role := role
				t.Run(role, func(t *testing.T) {
					registry := meta.NewRegistry()
					for _, item := range resources {
						registry.MustRegister(item)
					}
					actor := &authz.Actor{SuperAdmin: role == "superadmin"}
					if role == "read-only" {
						actor.Permissions = map[string]struct{}{
							"mfg.demand:read":     {},
							"mfg.work_order:read": {},
							"mfg.output:read":     {},
						}
					}
					document, err := registry.BuildDocument(resource.Name, actor)
					if err != nil {
						t.Fatal(err)
					}
					actualRaw, err := json.Marshal(document.Grid)
					if err != nil {
						t.Fatal(err)
					}
					snapshotPath := filepath.Join(
						"testdata", "meta", resource.Name+"."+role+".grid.json",
					)
					wantRaw, err := os.ReadFile(snapshotPath)
					if err != nil {
						t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
					}
					var actual, want any
					if err := json.Unmarshal(actualRaw, &actual); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(wantRaw, &want); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(actual, want) {
						t.Fatalf("GridMeta 不匹配\nactual=%s\nwant=%s", actualRaw, wantRaw)
					}
				})
			}
		})
	}
}
