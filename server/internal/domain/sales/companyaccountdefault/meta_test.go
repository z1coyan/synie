package companyaccountdefault

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestMetaMatchesLegacyCompanyAccountDefaultGrid(t *testing.T) {
	resource := ResourceMeta()
	if resource.Name != "salCompanyAccountDefaults" ||
		resource.PermissionPrefix != "sales.setting" ||
		resource.DestroyMutation != nil || len(resource.Actions) != 0 {
		t.Fatalf("resource = %#v", resource)
	}
	wantNames := []string{
		"id", "insertedAt", "updatedAt", "companyId", "deliveryDebitAccountId",
		"deliveryCreditAccountId", "receiptDebitAccountId", "receiptCreditAccountId",
	}
	gotNames := make([]string, len(resource.Fields))
	for i, field := range resource.Fields {
		gotNames[i] = field.APIName
	}
	if !slices.Equal(gotNames, wantNames) {
		t.Fatalf("columns = %#v", gotNames)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	readOnly := &authz.Actor{Permissions: map[string]struct{}{"sales.setting:read": {}}}
	document, err := registry.BuildDocument(ResourceName, readOnly)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 || document.Grid.DestroyMutation != nil {
		t.Fatalf("read-only grid = %#v", document.Grid)
	}
	for _, column := range document.Grid.Columns[3:] {
		if column.Ref != nil || column.Filterable || !column.Sortable || column.Type != "string" {
			t.Fatalf("reference-hidden column = %#v", column)
		}
	}
	document, err = registry.BuildDocument(ResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 {
		t.Fatalf("superadmin capabilities = %#v", document.Grid.Capabilities)
	}
	for _, column := range document.Grid.Columns[3:] {
		if column.Ref == nil || !column.Filterable || column.Sortable || column.Type != "fk" {
			t.Fatalf("superadmin FK column = %#v", column)
		}
	}
}
