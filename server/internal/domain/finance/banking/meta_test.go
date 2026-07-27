package banking

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/base/currency"
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
	registry.MustRegister(company.ResourceMeta())
	registry.MustRegister(currency.ResourceMeta())
	registry.MustRegister(account.ResourceMeta())
	registry.MustRegister(fileplatform.FileResourceMeta())
	registry.MustRegister(iam.UserResourceMeta())
	registry.MustRegister(gljournal.ResourceMeta())

	readOnly := &authz.Actor{Permissions: map[string]struct{}{
		"acc.bank_account:read":         {},
		"acc.bank_transaction:read":     {},
		"acc.bank_import_template:read": {},
		"base.company:read":             {},
		"base.account:read":             {},
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
