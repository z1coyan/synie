package stockdoc

import (
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaContract(t *testing.T) {
	resource := ResourceMeta()
	want := []string{
		"id", "docNo", "direction", "docDate", "summary", "remarks", "status",
		"auditedAt", "insertedAt", "updatedAt", "companyId", "warehouseId",
		"createdById", "auditedById",
	}
	assertFields(t, resource.Fields, want)
	wantActions := []string{"read", "create", "update", "delete", "audit", "void"}
	if len(resource.Actions) != len(wantActions) {
		t.Fatalf("actions = %#v", resource.Actions)
	}
	for i, action := range resource.Actions {
		if action.Key != wantActions[i] {
			t.Fatalf("action %d = %q", i, action.Key)
		}
	}
	if resource.DestroyMutation == nil || *resource.DestroyMutation != "destroyInvStockDoc" {
		t.Fatalf("destroy mutation = %v", resource.DestroyMutation)
	}
	if !resource.Audit.Enabled {
		t.Fatal("stock doc audit must be enabled")
	}
}

func TestItemResourceMetaContract(t *testing.T) {
	resource := ItemResourceMeta()
	want := []string{
		"id", "idx", "qty", "baseQty", "materialCode", "materialName",
		"materialSpec", "unitName", "remark", "insertedAt", "updatedAt",
		"stockDocId", "companyId", "materialId", "unitId",
	}
	assertFields(t, resource.Fields, want)
	for _, index := range []int{3, 4, 5, 6, 7, 12} {
		if !resource.Fields[index].Readonly {
			t.Fatalf("projection %q must be readonly", resource.Fields[index].APIName)
		}
	}
	if len(resource.Actions) != 1 || resource.Actions[0].Key != "read" {
		t.Fatalf("item actions = %#v", resource.Actions)
	}
	if resource.DestroyMutation == nil || *resource.DestroyMutation != "destroyInvStockDocItem" {
		t.Fatalf("destroy mutation = %v", resource.DestroyMutation)
	}
}

func assertFields(t *testing.T, fields []meta.FieldMeta, want []string) {
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
