package systemops

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestOnlyLegacyPublicAuditLogHasMeta(t *testing.T) {
	resources := ResourceMetas()
	if len(resources) != 1 || resources[0].Name != AuditLogResourceName {
		t.Fatalf("resources = %#v", resources)
	}
	resource := resources[0]
	want := []string{
		"id", "insertedAt", "resource", "recordId", "recordLabel", "actionType",
		"actionName", "actorId", "actorName", "companyId", "changes",
	}
	got := make([]string, len(resource.Fields))
	for i, field := range resource.Fields {
		got[i] = field.APIName
	}
	if !slices.Equal(got, want) {
		t.Fatalf("columns = %#v", got)
	}
	registry := meta.NewRegistry()
	registry.MustRegister(resource)
	document, err := registry.BuildDocument(AuditLogResourceName, &authz.Actor{
		Permissions: map[string]struct{}{"sys.audit_log:read": {}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Grid.Capabilities) != 0 || len(document.Grid.ExtendedActions) != 0 ||
		document.Grid.DestroyMutation != nil {
		t.Fatalf("read-only grid = %#v", document.Grid)
	}
	assertGridSnapshot(t, document.Grid, "sysAuditLogs.read-only.grid.json")
	adminDocument, err := registry.BuildDocument(AuditLogResourceName, &authz.Actor{SuperAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	assertGridSnapshot(t, adminDocument.Grid, "sysAuditLogs.superadmin.grid.json")
}

func TestAuthorizationRunsBeforeQueryValidation(t *testing.T) {
	service := NewService(nil)
	denied := &authz.Actor{UserID: uuid.New()}
	if code := errorCode(func() error {
		_, err := service.QueryAuditLogs(t.Context(), denied, ListQuery{Limit: -1})
		return err
	}()); code != apierror.CodeForbidden {
		t.Fatalf("audit error code = %q", code)
	}
	if code := errorCode(func() error {
		_, err := service.ListTodos(t.Context(), denied, TodoListQuery{
			ListQuery: ListQuery{Limit: -1},
		})
		return err
	}()); code != apierror.CodeForbidden {
		t.Fatalf("todo error code = %q", code)
	}
	if code := errorCode(func() error {
		_, err := service.MarkRead(t.Context(), denied, uuid.Nil)
		return err
	}()); code != apierror.CodeForbidden {
		t.Fatalf("mark-read error code = %q", code)
	}
}

func TestTodoEnumFiltersAcceptLegacyUppercaseWireValues(t *testing.T) {
	cases := []struct {
		field string
		raw   json.RawMessage
		want  []string
	}{
		{"type", json.RawMessage(`{"kind":"enum","values":["ISSUE_INVOICE"]}`), []string{"issue_invoice"}},
		{"status", json.RawMessage(`{"kind":"enum","values":["ACTIVE","CLOSED"]}`), []string{"active", "closed"}},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			built, err := filterbuild.Build(todoQueryMeta(), filterbuild.Query{
				Filter: map[string]json.RawMessage{tc.field: tc.raw},
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(built.Args) != 1 {
				t.Fatalf("args = %#v", built.Args)
			}
			if got, ok := built.Args[0].([]string); !ok || !slices.Equal(got, tc.want) {
				t.Fatalf("%s args = %#v", tc.field, built.Args[0])
			}
		})
	}
}

func errorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func assertGridSnapshot(t *testing.T, actual meta.GridMetaDTO, name string) {
	t.Helper()
	wantBytes, err := os.ReadFile(filepath.Join("testdata", "meta", name))
	if err != nil {
		t.Fatalf("meta 快照缺失或不可读（契约测试 fail-closed）: %v", err)
	}
	actualBytes, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err = json.Unmarshal(wantBytes, &want); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(actualBytes, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("grid differs from %s\nactual: %s\nwant: %s", name, actualBytes, wantBytes)
	}
}
