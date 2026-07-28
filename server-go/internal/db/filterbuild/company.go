package filterbuild

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// ImpossibleWhere is the fail-closed empty-result WHERE clause used when an
// actor is not authorized for any company. Prefer short-circuiting List
// handlers with an empty result when practical; this constant is for
// scopedWhere-style helpers that must still produce a runnable query.
const ImpossibleWhere = " WHERE false"

// CompanyScope is the fail-closed company isolation decision for a query.
//
//   - Bypass: superadmin / all-companies — do not filter by company.
//   - Empty: non-bypass actor with zero authorized companies — fail-closed;
//     callers must return empty results (or use ImpossibleWhere). Never
//     omit the filter.
//   - otherwise CompanyIDs holds the authorized set.
type CompanyScope struct {
	Bypass     bool
	Empty      bool
	CompanyIDs []uuid.UUID
}

// ResolveCompanyScope returns the fail-closed company isolation decision.
func ResolveCompanyScope(actor *authz.Actor) CompanyScope {
	bypass, ids := actor.CompanyFilter()
	if bypass {
		return CompanyScope{Bypass: true}
	}
	if len(ids) == 0 {
		return CompanyScope{Empty: true}
	}
	return CompanyScope{CompanyIDs: ids}
}

// AppendCompanyFilter appends a `"column" = ANY($n::uuid[])` predicate.
//
// Returns empty=true when the actor has no company access (fail-closed
// sentinel). In that case where/args are returned unchanged so callers can
// short-circuit to an empty ListResult or convert via ApplyCompanyFilter.
//
// column is the bare SQL column name (e.g. "company_id"); it is always
// double-quoted in the generated clause.
func AppendCompanyFilter(actor *authz.Actor, where string, args []any, column string) (string, []any, bool) {
	scope := ResolveCompanyScope(actor)
	if scope.Bypass {
		return where, args, false
	}
	if scope.Empty {
		return where, args, true
	}
	clause := fmt.Sprintf(`"%s" = ANY($%d::uuid[])`, column, len(args)+1)
	args = append(args, scope.CompanyIDs)
	if where == "" {
		where = " WHERE " + clause
	} else {
		where += " AND " + clause
	}
	return where, args, false
}

// ApplyCompanyFilter is like AppendCompanyFilter but converts the empty
// sentinel into an impossible WHERE (AND false / WHERE false), preserving
// prior args so existing $n placeholders remain valid.
func ApplyCompanyFilter(actor *authz.Actor, where string, args []any, column string) (string, []any) {
	where, args, empty := AppendCompanyFilter(actor, where, args, column)
	if !empty {
		return where, args
	}
	if where == "" {
		return ImpossibleWhere, args
	}
	return where + " AND false", args
}

// CompanyIDsOrNil returns authorized company IDs for hand-built SQL that
// still needs the raw slice (e.g. EXISTS subqueries). When Bypass is true,
// ids is nil and ok is true. When Empty is true, ok is false (fail-closed).
func CompanyIDsOrNil(actor *authz.Actor) (ids []uuid.UUID, bypass bool, ok bool) {
	scope := ResolveCompanyScope(actor)
	if scope.Bypass {
		return nil, true, true
	}
	if scope.Empty {
		return nil, false, false
	}
	return scope.CompanyIDs, false, true
}
