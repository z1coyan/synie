package iam

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type User struct {
	ID                uuid.UUID
	Username          string
	Name              *string
	PreferredLanguage *string
	InsertedAt        time.Time
	UpdatedAt         time.Time
}

type UserList struct {
	Count   int64
	Results []User
}
type UserCreate struct {
	Username            string
	Name                *string
	RoleIDs, CompanyIDs []uuid.UUID
}
type UserUpdate struct {
	Name                **string
	RoleIDs, CompanyIDs *[]uuid.UUID
}
type UserCreated struct {
	User     User
	Password string
}
type AccessItem struct {
	ID   uuid.UUID
	Name string
}
type UserAccess struct{ Roles, Companies []AccessItem }

type Role struct {
	ID                    uuid.UUID
	Code, Name            string
	Enabled, Builtin      bool
	InsertedAt, UpdatedAt time.Time
}

type RoleList struct {
	Count   int64
	Results []Role
}
type RoleCreate struct {
	Code, Name string
	Enabled    *bool
}
type RoleUpdate struct {
	Name    *string
	Enabled *bool
}
type GrantedPermission struct {
	ID         uuid.UUID
	Permission string
}
type RolePermissions struct{ Rows []GrantedPermission }
