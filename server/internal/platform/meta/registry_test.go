package meta

import (
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestRegistryBuildDocumentFiltersCapabilities(t *testing.T) {
	registry := NewRegistry()
	destroy := "destroyBasCurrency"
	registry.MustRegister(ResourceMeta{
		Name:             "basCurrencies",
		PermissionPrefix: "base.currency",
		PermissionLabel:  "币种",
		Table:            "bas_currency",
		Fields: []FieldMeta{
			{Name: "iso_code", APIName: "isoCode", DBColumn: "iso_code", Type: TypeString, Label: "ISO 编码", Filterable: true, Sortable: true},
			{Name: "secret", APIName: "secret", DBColumn: "secret", Type: TypeString, Label: "密钥", Sensitive: true},
		},
		Actions: []ActionMeta{
			{Key: "create"},
			{Key: "read"},
			{Key: "update"},
			{Key: "delete"},
		},
		DestroyMutation: &destroy,
	})

	actor := &authz.Actor{
		UserID: uuid.New(),
		Permissions: map[string]struct{}{
			"base.currency:read":   {},
			"base.currency:create": {},
			"base.currency:update": {},
		},
	}
	document, err := registry.BuildDocument("basCurrencies", actor)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Columns) != 1 || document.Grid.Columns[0].Name != "isoCode" {
		t.Fatalf("敏感字段未被裁剪: %#v", document.Grid.Columns)
	}
	if got := document.Grid.Capabilities; len(got) != 2 || got[0] != "create" || got[1] != "update" {
		t.Fatalf("capabilities = %#v", got)
	}
}

func TestRegistryFailsClosed(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(ResourceMeta{
		Name:             "basCurrencies",
		PermissionPrefix: "base.currency",
		PermissionLabel:  "币种",
		Table:            "bas_currency",
		Fields:           []FieldMeta{{Name: "name", APIName: "name", DBColumn: "name", Type: TypeString, Label: "名称"}},
		Actions:          []ActionMeta{{Key: "read"}},
	})
	_, err := registry.BuildDocument("basCurrencies", &authz.Actor{Permissions: map[string]struct{}{}})
	if apierror.Status(err) != 403 {
		t.Fatalf("want forbidden, got %v", err)
	}
	_, err = registry.BuildDocument("missing", &authz.Actor{SuperAdmin: true})
	if apierror.Status(err) != 404 {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestRegistryPreservesDeclaredExtendedActionOrder(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(ResourceMeta{
		Name:             "invStockTransfers",
		PermissionPrefix: "inv.stock_transfer",
		PermissionLabel:  "手工调拨单",
		Table:            "inv_stock_transfer",
		Fields:           []FieldMeta{{Name: "id", APIName: "id", DBColumn: "id", Type: TypeUUID, Label: "id"}},
		Actions: []ActionMeta{
			{Key: "read"},
			{Key: "ship", Label: "发货", Scope: "row"},
			{Key: "receive", Label: "收货", Scope: "row"},
		},
	})
	document, err := registry.BuildDocument("invStockTransfers", &authz.Actor{
		SuperAdmin: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := document.Grid.ExtendedActions
	if len(got) != 2 || got[0].Key != "ship" || got[1].Key != "receive" {
		t.Fatalf("extended action order = %#v", got)
	}
}

func TestRegistryDescribesExtendedActionsWithoutGrantingCapability(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(ResourceMeta{
		Name:             "invStockDocs",
		PermissionPrefix: "inv.stock_doc",
		PermissionLabel:  "手工出入库单",
		Table:            "inv_stock_doc",
		Fields:           []FieldMeta{{Name: "id", APIName: "id", DBColumn: "id", Type: TypeUUID, Label: "id"}},
		Actions: []ActionMeta{
			{Key: "read"},
			{Key: "audit", Label: "审核", Scope: "row"},
		},
	})
	document, err := registry.BuildDocument("invStockDocs", &authz.Actor{
		Permissions: map[string]struct{}{"inv.stock_doc:read": {}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 {
		t.Fatalf("capabilities = %#v", document.Grid.Capabilities)
	}
	if got := document.Grid.ExtendedActions; len(got) != 1 || got[0].Key != "audit" {
		t.Fatalf("extended actions = %#v", got)
	}
}
