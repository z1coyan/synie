package quotation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestMetaMatchesCapturedSnapshots(t *testing.T) {
	registry := meta.NewRegistry()
	for _, side := range []Side{SideSales, SidePurchase} {
		registry.MustRegister(QuotationResourceMeta(side))
		registry.MustRegister(ItemResourceMeta(side))
		registry.MustRegister(TierResourceMeta(side))
	}
	cases := []struct {
		resource string
		snapshot string
		actor    *authz.Actor
	}{
		{"salQuotations", "salQuotations.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salQuotations", "salQuotations.read-only.grid.json", readOnlyActor(SideSales)},
		{"salQuotationItems", "salQuotationItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salQuotationItems", "salQuotationItems.read-only.grid.json", readOnlyActor(SideSales)},
		{"salQuotationTiers", "salQuotationTiers.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salQuotationTiers", "salQuotationTiers.read-only.grid.json", readOnlyActor(SideSales)},
		{"purQuotations", "purQuotations.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purQuotations", "purQuotations.read-only.grid.json", readOnlyActor(SidePurchase)},
		{"purQuotationItems", "purQuotationItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purQuotationItems", "purQuotationItems.read-only.grid.json", readOnlyActor(SidePurchase)},
		{"purQuotationTiers", "purQuotationTiers.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purQuotationTiers", "purQuotationTiers.read-only.grid.json", readOnlyActor(SidePurchase)},
	}
	for _, tc := range cases {
		t.Run(tc.snapshot, func(t *testing.T) {
			document, err := registry.BuildDocument(tc.resource, tc.actor)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("testdata", "meta", tc.snapshot)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
			}
			var want meta.GridMetaDTO
			if err := json.Unmarshal(raw, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(document.Grid, want) {
				gotJSON, _ := json.MarshalIndent(document.Grid, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("captured GridMeta mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func readOnlyActor(side Side) *authz.Actor {
	return &authz.Actor{
		Permissions: map[string]struct{}{mustSpec(side).prefix + ":read": {}},
	}
}
