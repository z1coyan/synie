package standard

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
	registry.MustRegister(HeadResourceMeta(SideSales))
	registry.MustRegister(ItemResourceMeta(SideSales))
	registry.MustRegister(HeadResourceMeta(SidePurchase))
	registry.MustRegister(ItemResourceMeta(SidePurchase))

	cases := []struct {
		resource string
		snapshot string
		actor    *authz.Actor
	}{
		{"salDeliveries", "salDeliveries.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salDeliveries", "salDeliveries.read-only.grid.json", standardReadOnly(SideSales)},
		{"salDeliveryItems", "salDeliveryItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"salDeliveryItems", "salDeliveryItems.read-only.grid.json", standardReadOnly(SideSales)},
		{"purReceipts", "purReceipts.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purReceipts", "purReceipts.read-only.grid.json", standardReadOnly(SidePurchase)},
		{"purReceiptItems", "purReceiptItems.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{"purReceiptItems", "purReceiptItems.read-only.grid.json", standardReadOnly(SidePurchase)},
	}
	for _, tc := range cases {
		t.Run(tc.snapshot, func(t *testing.T) {
			document, err := registry.BuildDocument(tc.resource, tc.actor)
			if err != nil {
				t.Fatal(err)
			}
			gotRaw, err := json.Marshal(document.Grid)
			if err != nil {
				t.Fatal(err)
			}
			snapshotPath := filepath.Join(
				"..", "..", "..", "..", "..",
				".scratch", "migration", "snapshots", "pr-2.15", tc.snapshot,
			)
			wantRaw, err := os.ReadFile(snapshotPath)
			if os.IsNotExist(err) {
				t.Skip("repository .scratch snapshots are outside the mounted server module")
			}
			if err != nil {
				t.Fatal(err)
			}

			var got, want any
			if err := json.Unmarshal(gotRaw, &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(wantRaw, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				gotPretty, _ := json.MarshalIndent(got, "", "  ")
				wantPretty, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("captured GridMeta mismatch\n got: %s\nwant: %s", gotPretty, wantPretty)
			}
		})
	}
}

func standardReadOnly(side Side) *authz.Actor {
	return &authz.Actor{
		Permissions: map[string]struct{}{mustSpec(side).prefix + ":read": {}},
	}
}
