package filterbuild

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestResolveCompanyScopeFailClosed(t *testing.T) {
	t.Parallel()
	companyA, companyB := uuid.New(), uuid.New()

	cases := []struct {
		name    string
		actor   *authz.Actor
		bypass  bool
		empty   bool
		wantLen int
	}{
		{name: "nil actor", actor: nil, empty: true},
		{name: "no companies", actor: &authz.Actor{UserID: uuid.New()}, empty: true},
		{
			name: "superadmin", actor: &authz.Actor{SuperAdmin: true, CompanyIDs: []uuid.UUID{companyA}},
			bypass: true,
		},
		{
			name: "all companies", actor: &authz.Actor{AllCompanies: true},
			bypass: true,
		},
		{
			name: "scoped", actor: &authz.Actor{CompanyIDs: []uuid.UUID{companyA, companyB}},
			wantLen: 2,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			scope := ResolveCompanyScope(tc.actor)
			if scope.Bypass != tc.bypass || scope.Empty != tc.empty || len(scope.CompanyIDs) != tc.wantLen {
				t.Fatalf("scope = %#v, want bypass=%v empty=%v len=%d", scope, tc.bypass, tc.empty, tc.wantLen)
			}
		})
	}
}

func TestAppendCompanyFilter(t *testing.T) {
	t.Parallel()
	companyA := uuid.New()
	actor := &authz.Actor{CompanyIDs: []uuid.UUID{companyA}}

	where, args, empty := AppendCompanyFilter(actor, "", nil, "company_id")
	if empty {
		t.Fatal("scoped actor must not be empty")
	}
	if where != ` WHERE "company_id" = ANY($1::uuid[])` {
		t.Fatalf("where = %q", where)
	}
	if len(args) != 1 {
		t.Fatalf("args = %#v", args)
	}

	where, args, empty = AppendCompanyFilter(actor, ` WHERE "status" = $1`, []any{"draft"}, "company_id")
	if empty || !strings.Contains(where, ` AND "company_id" = ANY($2::uuid[])`) {
		t.Fatalf("where/empty = %q %v", where, empty)
	}
	if len(args) != 2 {
		t.Fatalf("args = %#v", args)
	}

	where, args, empty = AppendCompanyFilter(&authz.Actor{}, ` WHERE "status" = $1`, []any{"draft"}, "company_id")
	if !empty || where != ` WHERE "status" = $1` || len(args) != 1 {
		t.Fatalf("empty sentinel must leave where/args unchanged: %q %#v empty=%v", where, args, empty)
	}

	where, args, empty = AppendCompanyFilter(&authz.Actor{SuperAdmin: true}, "", nil, "company_id")
	if empty || where != "" || len(args) != 0 {
		t.Fatalf("bypass must leave query unfiltered: %q %#v empty=%v", where, args, empty)
	}
}

func TestApplyCompanyFilterEmptyPreservesArgs(t *testing.T) {
	t.Parallel()
	where, args := ApplyCompanyFilter(&authz.Actor{}, ` WHERE "status" = $1`, []any{"draft"}, "company_id")
	if where != ` WHERE "status" = $1 AND false` || len(args) != 1 || args[0] != "draft" {
		t.Fatalf("where/args = %q %#v", where, args)
	}
	where, args = ApplyCompanyFilter(&authz.Actor{}, "", nil, "company_id")
	if where != ImpossibleWhere {
		t.Fatalf("where = %q", where)
	}
}

func TestCompanyIDsOrNil(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	ids, bypass, ok := CompanyIDsOrNil(&authz.Actor{CompanyIDs: []uuid.UUID{id}})
	if bypass || !ok || len(ids) != 1 || ids[0] != id {
		t.Fatalf("ids=%v bypass=%v ok=%v", ids, bypass, ok)
	}
	_, bypass, ok = CompanyIDsOrNil(&authz.Actor{SuperAdmin: true})
	if !bypass || !ok {
		t.Fatalf("superadmin bypass=%v ok=%v", bypass, ok)
	}
	_, bypass, ok = CompanyIDsOrNil(&authz.Actor{})
	if bypass || ok {
		t.Fatalf("empty actor must fail-closed: bypass=%v ok=%v", bypass, ok)
	}
}
