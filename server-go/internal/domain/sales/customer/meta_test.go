package customer

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestCustomerMetaMatchesLegacyGridContract(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "salCustomers" || resource.PermissionPrefix != "sales.customer" ||
		resource.DestroyMutation == nil || *resource.DestroyMutation != "destroySalCustomer" {
		t.Fatalf("resource = %#v", resource)
	}
	wantNames := []string{"id", "code", "name", "shortName", "insertedAt", "updatedAt"}
	gotNames := make([]string, len(resource.Fields))
	for i, field := range resource.Fields {
		gotNames[i] = field.APIName
	}
	if !slices.Equal(gotNames, wantNames) {
		t.Fatalf("columns = %#v", gotNames)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	readOnly := &authz.Actor{Permissions: map[string]struct{}{"sales.customer:read": {}}}
	document, err := registry.BuildDocument(ResourceName, readOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 {
		t.Fatalf("read-only capabilities = %#v", document.Grid.Capabilities)
	}
	full := &authz.Actor{SuperAdmin: true}
	document, err = registry.BuildDocument(ResourceName, full)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(document.Grid.Capabilities, []string{"create", "update", "delete"}) {
		t.Fatalf("capabilities = %#v", document.Grid.Capabilities)
	}
}
