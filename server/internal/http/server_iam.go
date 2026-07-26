package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/iam"
)

func (s *Server) QuerySystemUsers(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sys.user:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	query, err := decodeIAMList(w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.iam.ListUsers(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.SystemUser, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, systemUserDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.SystemUserList{Count: result.Count, Results: items})
}

func (s *Server) GetSystemUser(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.user:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.iam.GetUser(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemUserDTO(item))
}

func (s *Server) CreateSystemUser(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.user:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SystemUserCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	created, err := s.iam.CreateUser(r.Context(), actor, iam.UserCreate{Username: body.Username, Name: body.Name, RoleIDs: uuidSlice(body.RoleIds), CompanyIDs: uuidSlice(body.CompanyIds)})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusCreated, gen.SystemUserCreated{User: systemUserDTO(created.User), Password: created.Password})
}

func (s *Server) UpdateSystemUser(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.user:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name       json.RawMessage `json:"name,omitempty"`
		RoleIDs    *[]uuid.UUID    `json:"roleIds,omitempty"`
		CompanyIDs *[]uuid.UUID    `json:"companyIds,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := iam.UserUpdate{RoleIDs: body.RoleIDs, CompanyIDs: body.CompanyIDs}
	if body.Name != nil {
		var name *string
		if string(body.Name) != "null" {
			var value string
			if err := json.Unmarshal(body.Name, &value); err != nil {
				s.writeError(w, r, apierror.Validation("用户参数不合法", map[string][]string{"name": {"必须是字符串或 null"}}))
				return
			}
			name = &value
		}
		input.Name = &name
	}
	item, err := s.iam.UpdateUser(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemUserDTO(item))
}

func (s *Server) DeleteSystemUser(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.user:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.iam.DeleteUser(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) GetSystemUserAccess(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.user:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	access, err := s.iam.UserAccess(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	roles := make([]gen.AccessItem, 0, len(access.Roles))
	for _, item := range access.Roles {
		roles = append(roles, gen.AccessItem{Id: item.ID, Name: item.Name})
	}
	companies := make([]gen.AccessItem, 0, len(access.Companies))
	for _, item := range access.Companies {
		companies = append(companies, gen.AccessItem{Id: item.ID, Name: item.Name})
	}
	s.writeJSON(w, http.StatusOK, gen.SystemUserAccess{Roles: roles, Companies: companies})
}

func (s *Server) ResetSystemUserPassword(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.user:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	password, err := s.iam.ResetPassword(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusOK, gen.OneTimePassword{Password: password})
}

func (s *Server) QuerySystemRoles(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sys.role:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	query, err := decodeIAMList(w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.iam.ListRoles(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.SystemRole, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, systemRoleDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.SystemRoleList{Count: result.Count, Results: items})
}

func (s *Server) GetSystemRole(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.role:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.iam.GetRole(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemRoleDTO(item))
}

func (s *Server) CreateSystemRole(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.role:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SystemRoleCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.iam.CreateRole(r.Context(), actor, iam.RoleCreate{Code: body.Code, Name: body.Name, Enabled: body.Enabled})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, systemRoleDTO(item))
}

func (s *Server) UpdateSystemRole(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.role:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SystemRoleUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.iam.UpdateRole(r.Context(), actor, id, iam.RoleUpdate{Name: body.Name, Enabled: body.Enabled})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemRoleDTO(item))
}

func (s *Server) DeleteSystemRole(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.role:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.iam.DeleteRole(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) GetSystemRolePermissions(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.role_permission:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.iam.RolePermissions(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	rows := make([]gen.RolePermissionRow, 0, len(result.Rows))
	for _, row := range result.Rows {
		rows = append(rows, gen.RolePermissionRow{Id: row.ID, Permission: row.Permission})
	}
	s.writeJSON(w, http.StatusOK, gen.RolePermissionRows{Rows: rows})
}

func (s *Server) SyncSystemRolePermissions(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.role_permission:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := requirePermission(r, "sys.role_permission:delete"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.RolePermissionSync
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	permissions, err := s.iam.SyncRolePermissions(r.Context(), actor, id, body.Permissions)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.RolePermissionCodes{Permissions: permissions})
}

func decodeIAMList(w http.ResponseWriter, r *http.Request) (iam.ListQuery, error) {
	var body struct {
		Limit  *int                       `json:"limit,omitempty"`
		Offset *int                       `json:"offset,omitempty"`
		Search *string                    `json:"search,omitempty"`
		Sort   *gen.Sort                  `json:"sort,omitempty"`
		Filter map[string]json.RawMessage `json:"filter,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return iam.ListQuery{}, invalidJSON(err)
	}
	result := iam.ListQuery{Filter: body.Filter}
	if body.Limit != nil {
		result.Limit = *body.Limit
	}
	if body.Offset != nil {
		result.Offset = *body.Offset
	}
	if body.Search != nil {
		result.Search = *body.Search
	}
	if body.Sort != nil {
		result.Sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	return result, nil
}

func systemUserDTO(item iam.User) gen.SystemUser {
	return gen.SystemUser{Id: item.ID, Username: item.Username, Name: item.Name, PreferredLanguage: item.PreferredLanguage, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt}
}
func systemRoleDTO(item iam.Role) gen.SystemRole {
	return gen.SystemRole{Id: item.ID, Code: item.Code, Name: item.Name, Enabled: item.Enabled, Builtin: item.Builtin, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt}
}
func uuidSlice(values *[]uuid.UUID) []uuid.UUID {
	if values == nil {
		return nil
	}
	return append([]uuid.UUID(nil), (*values)...)
}
