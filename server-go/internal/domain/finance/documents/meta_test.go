package documents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetasMatchLegacyGridSnapshots(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range ResourceMetas() {
		registry.MustRegister(resource)
	}
	for _, resource := range []meta.ResourceMeta{
		stubMeta("basCompanies", "base.company"),
		stubMeta("basAccounts", "base.account"),
		stubMeta("salCustomers", "sales.customer"),
		stubMeta("purSuppliers", "purchase.supplier"),
		stubMeta("hrEmployees", "hr.employee"),
		stubMeta("sysUsers", "sys.user"),
		stubMeta("salReconciliations", "sales.reconciliation"),
		stubMeta("purReconciliations", "purchase.reconciliation"),
		stubMeta("accBankAccounts", "acc.bank_account"),
	} {
		registry.MustRegister(resource)
	}
	readOnly := &authz.Actor{Permissions: map[string]struct{}{
		"acc.vat_invoice:read":         {},
		"acc.expense_report:read":      {},
		"acc.bill:read":                {},
		"acc.bill_transaction:read":    {},
		"acc.bill_holding:read":        {},
		"base.company:read":            {},
		"base.account:read":            {},
		"sales.customer:read":          {},
		"purchase.supplier:read":       {},
		"sys.user:read":                {},
		"sales.reconciliation:read":    {},
		"purchase.reconciliation:read": {},
		"acc.bank_account:read":        {},
	}}
	for _, resource := range ResourceMetas() {
		for actorName, actor := range map[string]*authz.Actor{
			"superadmin": {SuperAdmin: true},
			"read-only":  readOnly,
		} {
			document, err := registry.BuildDocument(resource.Name, actor)
			if err != nil {
				t.Fatalf("%s/%s: %v", resource.Name, actorName, err)
			}
			path := filepath.Join(
				"testdata", "meta", resource.Name+"."+actorName+".grid.json",
			)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
			}
			var want, got any
			if err = json.Unmarshal(raw, &want); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(document.Grid)
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s/%s grid mismatch\n got: %s\nwant: %s",
					resource.Name, actorName, encoded, raw)
			}
		}
	}
}

func stubMeta(name, permission string) meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: name, PermissionPrefix: permission, PermissionLabel: name, Table: "stub",
		Actions: []meta.ActionMeta{{Key: "read"}},
	}
}
