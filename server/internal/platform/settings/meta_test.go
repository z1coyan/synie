package settings

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestSettingGridMetaMatchesCapturedElixirContracts(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range ResourceMetas() {
		registry.MustRegister(resource)
	}
	actor := &authz.Actor{SuperAdmin: true}
	for _, name := range []string{
		SalesResourceName,
		ManufacturingResourceName,
		AccountingResourceName,
		SystemResourceName,
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile("testdata/meta/" + name + ".grid.json")
			if err != nil {
				t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
			}
			var captured meta.GridMetaDTO
			if err := json.Unmarshal(raw, &captured); err != nil {
				t.Fatal(err)
			}
			document, err := registry.BuildDocument(name, actor)
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

func TestAccountingMetaNeverExposesSecret(t *testing.T) {
	for _, field := range AccountingResourceMeta().Fields {
		if field.APIName == "ocrAccessKeySecret" || field.DBColumn == "ocr_access_key_secret" {
			t.Fatalf("财务设置 Meta 泄漏了密钥字段: %#v", field)
		}
	}
}
