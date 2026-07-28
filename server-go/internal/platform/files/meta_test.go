package files

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestFilesMetaMatchesCapturedContracts(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		resource meta.ResourceMeta
		path     string
	}{
		{name: FileResourceName, resource: FileResourceMeta(), path: "testdata/meta/sysFiles.grid.json"},
		{name: StorageResourceName, resource: StorageResourceMeta(), path: "testdata/meta/sysStorages.grid.json"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			raw, err := os.ReadFile(tc.path)
			if err != nil {
				t.Fatal(err)
			}
			var captured meta.GridMetaDTO
			if err = json.Unmarshal(raw, &captured); err != nil {
				t.Fatal(err)
			}
			registry := meta.NewRegistry()
			registry.MustRegister(tc.resource)
			document, err := registry.BuildDocument(tc.name, &authz.Actor{SuperAdmin: true})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(document.Grid, captured) {
				got, _ := json.MarshalIndent(document.Grid, "", "  ")
				t.Fatalf("Go GridMeta 与捕获契约不一致:\n%s", got)
			}
		})
	}
}

func TestStorageMetaDoesNotExposeSecret(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(StorageResourceMeta())
	document, err := registry.BuildDocument(StorageResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range document.Grid.Columns {
		if column.Name == "secretAccessKey" {
			t.Fatal("write-only secret leaked into GridMeta")
		}
	}
}
