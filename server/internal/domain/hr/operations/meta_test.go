package operations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/iam"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetasMatchLegacyGridSnapshots(t *testing.T) {
	registry := meta.NewRegistry()
	for _, resource := range ResourceMetas() {
		registry.MustRegister(resource)
	}
	registry.MustRegister(employee.ResourceMeta())
	registry.MustRegister(fileplatform.FileResourceMeta())
	registry.MustRegister(iam.UserResourceMeta())

	readOnly := &authz.Actor{Permissions: map[string]struct{}{
		"hr.attendance_punch:read":      {},
		"hr.attendance_day:read":        {},
		"hr.attendance_correction:read": {},
		"hr.payroll:read":               {},
		"hr.payroll_payment:read":       {},
		"hr.employee_loan:read":         {},
		"hr.employee:read":              {},
		"sys.file:read":                 {},
		"sys.user:read":                 {},
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
				"..", "..", "..", "..", "..", ".scratch", "migration", "snapshots", "pr-2.19",
				resource.Name+"."+actorName+".grid.json",
			)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
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
