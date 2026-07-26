package stockcount

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaMatchesCapturedContract(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != ResourceName || resource.PermissionPrefix != "inv.stock_count" {
		t.Fatalf("resource = %#v", resource)
	}
	assertFieldNames(t, resource.Fields, []string{
		"id", "docNo", "postingDate", "summary", "remarks", "status", "auditedAt",
		"snapshotTakenAt", "insertedAt", "updatedAt", "companyId", "warehouseId",
		"createdById", "auditedById",
	})
	wantActions := []string{"read", "create", "update", "delete", "approve", "cancel"}
	gotActions := make([]string, len(resource.Actions))
	for i, action := range resource.Actions {
		gotActions[i] = action.Key
	}
	if !slices.Equal(gotActions, wantActions) {
		t.Fatalf("actions = %#v", gotActions)
	}
	if resource.DestroyMutation == nil || *resource.DestroyMutation != "destroyInvStockCount" {
		t.Fatalf("destroy mutation = %v", resource.DestroyMutation)
	}

	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	readOnly := &authz.Actor{
		Permissions: map[string]struct{}{"inv.stock_count:read": {}},
	}
	document, err := registry.BuildDocument(ResourceName, readOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 {
		t.Fatalf("read-only capabilities = %#v", document.Grid.Capabilities)
	}
	document, err = registry.BuildDocument(ResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(
		document.Grid.Capabilities,
		[]string{"create", "update", "delete", "approve", "cancel"},
	) {
		t.Fatalf("superadmin capabilities = %#v", document.Grid.Capabilities)
	}
}

func TestItemResourceMetaMatchesCapturedContract(t *testing.T) {
	resource := ItemResourceMeta()
	assertFieldNames(t, resource.Fields, []string{
		"id", "countedQuantity", "convertedCounted", "bookQuantity", "materialCode",
		"materialName", "materialSpec", "unitName", "remark", "insertedAt",
		"updatedAt", "countId", "companyId", "materialId", "unitId",
	})
	for _, index := range []int{2, 3, 4, 5, 6, 7, 12} {
		if !resource.Fields[index].Readonly {
			t.Fatalf("projection %q must be readonly", resource.Fields[index].APIName)
		}
	}
	if len(resource.Actions) != 1 || resource.Actions[0].Key != "read" {
		t.Fatalf("item actions = %#v", resource.Actions)
	}
	if resource.DestroyMutation == nil ||
		*resource.DestroyMutation != "destroyInvStockCountItem" {
		t.Fatalf("destroy mutation = %v", resource.DestroyMutation)
	}
}

func assertFieldNames(t *testing.T, fields []meta.FieldMeta, want []string) {
	t.Helper()
	if len(fields) != len(want) {
		t.Fatalf("field count = %d, want %d", len(fields), len(want))
	}
	for i, field := range fields {
		if field.APIName != want[i] {
			t.Fatalf("field %d = %q, want %q", i, field.APIName, want[i])
		}
	}
}
