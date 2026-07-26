package outsourced

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
	for _, resource := range []meta.ResourceMeta{
		IssueResourceMeta(),
		IssueItemResourceMeta(),
		ReceiptResourceMeta(),
		ReceiptItemResourceMeta(),
		ReceiptMaterialResourceMeta(),
		ReceiptByproductResourceMeta(),
	} {
		registry.MustRegister(resource)
	}

	superadmin := &authz.Actor{SuperAdmin: true}
	issueReader := readOnlyActor(issuePermissionPrefix)
	receiptReader := readOnlyActor(receiptPermissionPrefix)
	cases := []struct {
		resource string
		snapshot string
		actor    *authz.Actor
	}{
		{IssueResourceName, "purOutsourcedIssues.superadmin.grid.json", superadmin},
		{IssueResourceName, "purOutsourcedIssues.read-only.grid.json", issueReader},
		{IssueItemResourceName, "purOutsourcedIssueItems.superadmin.grid.json", superadmin},
		{IssueItemResourceName, "purOutsourcedIssueItems.read-only.grid.json", issueReader},
		{ReceiptResourceName, "purOutsourcedReceipts.superadmin.grid.json", superadmin},
		{ReceiptResourceName, "purOutsourcedReceipts.read-only.grid.json", receiptReader},
		{ReceiptItemResourceName, "purOutsourcedReceiptItems.superadmin.grid.json", superadmin},
		{ReceiptItemResourceName, "purOutsourcedReceiptItems.read-only.grid.json", receiptReader},
		{ReceiptMaterialResourceName, "purOutsourcedReceiptItemMaterials.superadmin.grid.json", superadmin},
		{ReceiptMaterialResourceName, "purOutsourcedReceiptItemMaterials.read-only.grid.json", receiptReader},
		{ReceiptByproductResourceName, "purOutsourcedReceiptItemByproducts.superadmin.grid.json", superadmin},
		{ReceiptByproductResourceName, "purOutsourcedReceiptItemByproducts.read-only.grid.json", receiptReader},
	}

	for _, tc := range cases {
		t.Run(tc.snapshot, func(t *testing.T) {
			document, err := registry.BuildDocument(tc.resource, tc.actor)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("..", "..", "..", "..", "..", ".scratch",
				"migration", "snapshots", "pr-2.15", tc.snapshot)
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

func readOnlyActor(permissionPrefix string) *authz.Actor {
	return &authz.Actor{
		Permissions: map[string]struct{}{permissionPrefix + ":read": {}},
	}
}
