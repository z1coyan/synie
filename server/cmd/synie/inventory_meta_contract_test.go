package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestInventoryGridMetaMatchesCapturedContract(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range []meta.ResourceMeta{
		materialcategory.ResourceMeta(),
		material.ResourceMeta(),
		materialunit.ResourceMeta(),
		warehouse.ResourceMeta(),
		stockentry.ResourceMeta(),
		stockdoc.ResourceMeta(),
		stockdoc.ItemResourceMeta(),
		stocktransfer.ResourceMeta(),
		stocktransfer.ItemResourceMeta(),
		stockcount.ResourceMeta(),
		stockcount.ItemResourceMeta(),
	} {
		registry.MustRegister(resource)
	}
	masterReadOnly := &authz.Actor{Permissions: map[string]struct{}{}}
	for _, permission := range []string{
		"inv.material_category:read",
		"inv.material:read",
		"inv.warehouse:read",
	} {
		masterReadOnly.Permissions[permission] = struct{}{}
	}
	documentReadOnly := &authz.Actor{Permissions: map[string]struct{}{}}
	for _, permission := range []string{
		"inv.stock_entry:read",
		"inv.stock_doc:read",
		"inv.stock_transfer:read",
		"inv.stock_count:read",
	} {
		documentReadOnly.Permissions[permission] = struct{}{}
	}
	for _, resourceName := range []string{
		materialcategory.ResourceName,
		material.ResourceName,
		materialunit.ResourceName,
		warehouse.ResourceName,
		stockentry.ResourceName,
		stockdoc.ResourceName,
		stockdoc.ItemResourceName,
		stocktransfer.ResourceName,
		stocktransfer.ItemResourceName,
		stockcount.ResourceName,
		stockcount.ItemResourceName,
	} {
		readOnly := documentReadOnly
		switch resourceName {
		case materialcategory.ResourceName, material.ResourceName,
			materialunit.ResourceName, warehouse.ResourceName:
			readOnly = masterReadOnly
		}
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
				path := filepath.Join(
					"..", "..", "..", ".scratch", "migration", "snapshots", "pr-2.11",
					resourceName+"."+tc.name+".grid.json",
				)
				raw, err := os.ReadFile(path)
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
