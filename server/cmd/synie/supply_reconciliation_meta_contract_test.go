package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/scm/orderflow"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestSupplyReconciliationGridMetaMatchesCapturedContract(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range []meta.ResourceMeta{
		company.ResourceMeta(),
		account.ResourceMeta(),
		customer.ResourceMeta(),
		supplier.ResourceMeta(),
		standard.HeadResourceMeta(standard.SideSales),
		standard.ItemResourceMeta(standard.SideSales),
		standard.HeadResourceMeta(standard.SidePurchase),
		standard.ItemResourceMeta(standard.SidePurchase),
		outsourced.ReceiptResourceMeta(),
		outsourced.ReceiptItemResourceMeta(),
		reconciliation.HeadResourceMeta(reconciliation.SideSales),
		reconciliation.ItemResourceMeta(reconciliation.SideSales),
		reconciliation.HeadResourceMeta(reconciliation.SidePurchase),
		reconciliation.ItemResourceMeta(reconciliation.SidePurchase),
		companyaccountdefault.ResourceMeta(),
		orderflow.ResourceMeta(),
	} {
		registry.MustRegister(resource)
	}
	readOnly := &authz.Actor{Permissions: map[string]struct{}{
		"sales.reconciliation:read":    {},
		"purchase.reconciliation:read": {},
		"sales.setting:read":           {},
		"sales.delivery:read":          {},
	}}
	for _, resourceName := range []string{
		"salReconciliations",
		"salReconciliationItems",
		"salCompanyAccountDefaults",
		"purReconciliations",
		"purReconciliationItems",
		"scmOrderFlowItems",
	} {
		for _, tc := range []struct {
			name  string
			actor *authz.Actor
		}{
			{"superadmin", &authz.Actor{SuperAdmin: true}},
			{"read-only", readOnly},
		} {
			t.Run(resourceName+"/"+tc.name, func(t *testing.T) {
				document, err := registry.BuildDocument(resourceName, tc.actor)
				if err != nil {
					t.Fatal(err)
				}
				raw, err := os.ReadFile(filepath.Join(
					"..", "..", "..", ".scratch", "migration", "snapshots", "pr-2.16",
					resourceName+"."+tc.name+".grid.json",
				))
				if err != nil {
					t.Fatal(err)
				}
				var expected any
				if err := json.Unmarshal(raw, &expected); err != nil {
					t.Fatal(err)
				}
				gotRaw, err := json.Marshal(document.Grid)
				if err != nil {
					t.Fatal(err)
				}
				var got any
				if err := json.Unmarshal(gotRaw, &got); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, expected) {
					pretty, _ := json.MarshalIndent(document.Grid, "", "  ")
					t.Fatalf("GridMeta mismatch\n%s", pretty)
				}
			})
		}
	}
}
