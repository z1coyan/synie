package order

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
	registry.MustRegister(OrderResourceMeta(SideSales))
	registry.MustRegister(ItemResourceMeta(SideSales))
	registry.MustRegister(OrderResourceMeta(SidePurchase))
	registry.MustRegister(ItemResourceMeta(SidePurchase))
	registry.MustRegister(MaterialResourceMeta())
	registry.MustRegister(ByproductResourceMeta())
	cases := []struct {
		resource string
		snapshot string
		actor    *authz.Actor
	}{
		{"salOrders", "salOrders.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salOrders", "salOrders.read-only.grid.json", orderReadOnly(SideSales)},
		{"salOrderItems", "salOrderItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salOrderItems", "salOrderItems.read-only.grid.json", orderReadOnly(SideSales)},
		{"purOrders", "purOrders.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purOrders", "purOrders.read-only.grid.json", orderReadOnly(SidePurchase)},
		{"purOrderItems", "purOrderItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purOrderItems", "purOrderItems.read-only.grid.json", orderReadOnly(SidePurchase)},
		{"purOrderItemMaterials", "purOrderItemMaterials.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purOrderItemMaterials", "purOrderItemMaterials.read-only.grid.json", orderReadOnly(SidePurchase)},
		{"purOrderItemByproducts", "purOrderItemByproducts.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purOrderItemByproducts", "purOrderItemByproducts.read-only.grid.json", orderReadOnly(SidePurchase)},
	}
	for _, tc := range cases {
		t.Run(tc.snapshot, func(t *testing.T) {
			document, err := registry.BuildDocument(tc.resource, tc.actor)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("..", "..", "..", "..", "..", ".scratch",
				"migration", "snapshots", "pr-2.14", tc.snapshot)
			raw, err := os.ReadFile(path)
			if os.IsNotExist(err) {
				t.Skip("repository .scratch snapshots are outside the mounted server module")
			}
			if err != nil {
				t.Fatal(err)
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

func orderReadOnly(side Side) *authz.Actor {
	return &authz.Actor{Permissions: map[string]struct{}{mustSpec(side).prefix + ":read": {}}}
}
