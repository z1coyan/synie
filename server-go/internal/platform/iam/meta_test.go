package iam

import (
	"slices"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestUserMetaMatchesElixirPublicSurface(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(UserResourceMeta())
	doc, err := registry.BuildDocument(UserResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	wantColumns := []string{"id", "username", "name", "preferredLanguage", "insertedAt", "updatedAt"}
	gotColumns := make([]string, len(doc.Grid.Columns))
	for index, column := range doc.Grid.Columns {
		gotColumns[index] = column.Name
	}
	if !slices.Equal(gotColumns, wantColumns) {
		t.Fatalf("columns = %#v", gotColumns)
	}
	if !slices.Equal(doc.Grid.Capabilities, []string{"create", "update", "delete"}) {
		t.Fatalf("capabilities = %#v", doc.Grid.Capabilities)
	}
	if doc.Form == nil || !slices.Contains(doc.Form.Exclude, "preferredLanguage") {
		t.Fatalf("unexpected form = %#v", doc.Form)
	}
	if !slices.Contains(UserResourceMeta().Audit.SensitiveFields, "hashed_password") {
		t.Fatal("hashed_password must stay audit-sensitive")
	}
}

func TestRoleMetaPreservesExtendedCRUDCapabilities(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(RoleResourceMeta())
	actor := &authz.Actor{Permissions: map[string]struct{}{
		"sys.role:read": {}, "sys.role:export": {}, "sys.role:batch_print": {},
	}}
	doc, err := registry.BuildDocument(RoleResourceName, actor)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(doc.Grid.Capabilities, []string{"export", "batch_print"}) {
		t.Fatalf("capabilities = %#v", doc.Grid.Capabilities)
	}
	if len(doc.Grid.Columns) != 7 || doc.Grid.Columns[1].Name != "code" || doc.Grid.Columns[4].Name != "builtin" {
		t.Fatalf("unexpected role columns = %#v", doc.Grid.Columns)
	}
}

func TestRolePermissionMetaIsInPermissionCatalog(t *testing.T) {
	t.Parallel()
	registry := meta.NewRegistry()
	registry.MustRegister(RolePermissionResourceMeta())
	catalog := registry.PermissionCatalog()
	if len(catalog) != 1 || catalog[0].Prefix != "sys.role_permission" ||
		!slices.Equal(catalog[0].Actions, []string{"create", "delete", "read"}) {
		t.Fatalf("catalog = %#v", catalog)
	}
}
