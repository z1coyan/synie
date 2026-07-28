package authz

import (
	"slices"

	"github.com/google/uuid"
)

type Actor struct {
	UserID       uuid.UUID
	Username     string
	Name         *string
	SuperAdmin   bool
	AllCompanies bool
	Permissions  map[string]struct{}
	CompanyIDs   []uuid.UUID
}

func (a *Actor) HasPermission(code string) bool {
	if a == nil {
		return false
	}
	if a.SuperAdmin {
		return true
	}
	return Matches(a.Permissions, code)
}

func (a *Actor) CompanyFilter() (bypass bool, ids []uuid.UUID) {
	if a == nil {
		return false, nil
	}
	if a.SuperAdmin || a.AllCompanies {
		return true, nil
	}
	return false, slices.Clone(a.CompanyIDs)
}

func (a *Actor) CanAccessCompany(id uuid.UUID) bool {
	if a == nil {
		return false
	}
	if a.SuperAdmin || a.AllCompanies {
		return true
	}
	return slices.Contains(a.CompanyIDs, id)
}
