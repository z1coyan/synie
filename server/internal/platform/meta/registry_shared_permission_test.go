package meta

import (
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestRegistryAllowsResourcesToShareOnePermissionGroup(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(ResourceMeta{
		Name: "sysNumberingRules", PermissionPrefix: "sys.numbering_rule",
		PermissionLabel: "编号规则", Table: "sys_numbering_rule",
		Fields: []FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Label: "id", Type: TypeUUID},
		},
		Actions: []ActionMeta{
			{Key: "read"}, {Key: "create"}, {Key: "update"}, {Key: "delete"},
		},
	})
	registry.MustRegister(ResourceMeta{
		Name: "sysNumberingCounters", PermissionPrefix: "sys.numbering_rule",
		PermissionLabel: "编号规则", Table: "sys_numbering_counter",
		Fields: []FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Label: "id", Type: TypeUUID},
		},
	})

	actor := &authz.Actor{SuperAdmin: true}
	if _, err := registry.BuildDocument("sysNumberingRules", actor); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.BuildDocument("sysNumberingCounters", actor); err != nil {
		t.Fatal(err)
	}
	catalog := registry.PermissionCatalog()
	if len(catalog) != 1 {
		t.Fatalf("permission groups = %#v", catalog)
	}
	group := catalog[0]
	if group.Prefix != "sys.numbering_rule" || group.Label != "编号规则" ||
		len(group.Actions) != 4 ||
		group.Actions[0] != "create" || group.Actions[1] != "delete" ||
		group.Actions[2] != "read" || group.Actions[3] != "update" {
		t.Fatalf("shared permission group = %#v", group)
	}
}
