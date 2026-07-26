package orderflow

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestMetaMatchesLegacyOrderFlowGridAndPermissionOR(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "scmOrderFlowItems" ||
		resource.PermissionPrefix != "scm.order_flow" ||
		resource.DestroyMutation != nil || len(resource.Actions) != 0 {
		t.Fatalf("resource = %#v", resource)
	}
	wantNames := []string{
		"id", "flowType", "voucherNo", "voucherDate", "status", "qty",
		"materialCode", "materialName", "materialSpec", "customerPartNo", "unitName",
		"orderId", "orderItemId", "companyId",
	}
	gotNames := make([]string, len(resource.Fields))
	for i, field := range resource.Fields {
		gotNames[i] = field.APIName
		if !field.Sortable {
			t.Fatalf("%s must be sortable", field.APIName)
		}
		if i < 11 && !field.Filterable {
			t.Fatalf("%s must be filterable", field.APIName)
		}
		if i >= 11 && field.Filterable {
			t.Fatalf("%s must not be generic-grid filterable", field.APIName)
		}
	}
	if !slices.Equal(gotNames, wantNames) {
		t.Fatalf("columns = %#v", gotNames)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	for _, permission := range sourceReadPermissions {
		actor := &authz.Actor{Permissions: map[string]struct{}{permission: {}}}
		if !CanRead(actor) {
			t.Fatalf("%s must authorize read", permission)
		}
		document, err := registry.BuildDocument(ResourceName, actor)
		if err != nil || len(document.Grid.Columns) != len(wantNames) {
			t.Fatalf("%s meta document = %#v, %v", permission, document, err)
		}
	}
	if CanRead(&authz.Actor{Permissions: map[string]struct{}{"scm.order_flow:read": {}}}) {
		t.Fatal("synthetic scm.order_flow permission must not authorize domain reads")
	}
	if len(registry.PermissionCatalog()) != 0 {
		t.Fatalf("order flow must not create a permission group: %#v", registry.PermissionCatalog())
	}
}
