package iam

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

type Service struct {
	pool     *pgxpool.Pool
	hasher   auth.PasswordHasher
	registry *meta.Registry
}

func NewService(pool *pgxpool.Pool, hasher auth.PasswordHasher, registry *meta.Registry) *Service {
	return &Service{pool: pool, hasher: hasher, registry: registry}
}

func (s *Service) GetUser(ctx context.Context, id uuid.UUID) (User, error) {
	row, err := dbgen.New(s.pool).GetIAMUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, apierror.New(apierror.CodeNotFound, "用户不存在")
	}
	if err != nil {
		return User{}, apierror.Wrap(apierror.CodeInternal, "读取用户失败", err)
	}
	return userFromGet(row), nil
}

func (s *Service) ListUsers(ctx context.Context, query ListQuery) (UserList, error) {
	if err := validatePage(&query); err != nil {
		return UserList{}, err
	}
	built, err := filterbuild.Build(UserResourceMeta(), filterbuild.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter})
	if err != nil {
		return UserList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "username" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return UserList{}, apierror.Wrap(apierror.CodeInternal, "查询用户失败", err)
	}
	defer tx.Rollback(ctx)
	var result UserList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sys_user`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return UserList{}, apierror.Wrap(apierror.CodeInternal, "统计用户失败", err)
	}
	args, limitAt := append([]any(nil), built.Args...), len(built.Args)+1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id, username::text, name, preferred_language, inserted_at, updated_at FROM sys_user`+built.Where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), args...)
	if err != nil {
		return UserList{}, apierror.Wrap(apierror.CodeInternal, "查询用户失败", err)
	}
	defer rows.Close()
	result.Results = make([]User, 0, query.Limit)
	for rows.Next() {
		var item User
		if err := rows.Scan(&item.ID, &item.Username, &item.Name, &item.PreferredLanguage, &item.InsertedAt, &item.UpdatedAt); err != nil {
			return UserList{}, apierror.Wrap(apierror.CodeInternal, "读取用户结果失败", err)
		}
		item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return UserList{}, apierror.Wrap(apierror.CodeInternal, "遍历用户结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return UserList{}, apierror.Wrap(apierror.CodeInternal, "完成用户查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateUser(ctx context.Context, actor *authz.Actor, input UserCreate) (UserCreated, error) {
	if err := normalizeUserCreate(&input); err != nil {
		return UserCreated{}, err
	}
	password, err := randomPassword()
	if err != nil {
		return UserCreated{}, apierror.Wrap(apierror.CodeInternal, "生成初始密码失败", err)
	}
	hash, err := s.hasher.Hash(password)
	if err != nil {
		return UserCreated{}, apierror.Wrap(apierror.CodeInternal, "生成密码哈希失败", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UserCreated{}, apierror.Wrap(apierror.CodeInternal, "创建用户失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.CreateIAMUser(ctx, dbgen.CreateIAMUserParams{Username: input.Username, Name: text(input.Name), HashedPassword: hash})
	if err != nil {
		return UserCreated{}, mapWriteError("创建用户失败", err)
	}
	item := userFromCreate(row)
	if err := replaceAccess(ctx, q, item.ID, input.RoleIDs, input.CompanyIDs); err != nil {
		return UserCreated{}, mapWriteError("保存用户角色/公司失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_user", RecordID: item.ID, RecordLabel: item.Username, ActionType: "create", ActionName: "create", Changes: audit.Created(userSnapshot(item, input.RoleIDs, input.CompanyIDs), userAuditFields)}); err != nil {
		return UserCreated{}, apierror.Wrap(apierror.CodeInternal, "创建用户失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return UserCreated{}, mapWriteError("创建用户失败", err)
	}
	return UserCreated{User: item, Password: password}, nil
}

func (s *Service) UpdateUser(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UserUpdate) (User, error) {
	if err := normalizeUserUpdate(&input); err != nil {
		return User{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, apierror.Wrap(apierror.CodeInternal, "更新用户失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockIAMUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, apierror.New(apierror.CodeNotFound, "用户不存在")
	}
	if err != nil {
		return User{}, apierror.Wrap(apierror.CodeInternal, "更新用户失败", err)
	}
	before := userFromLock(locked)
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	access, err := accessWith(q, ctx, id)
	if err != nil {
		return User{}, err
	}
	roleIDs, companyIDs := accessIDs(access)
	if input.RoleIDs != nil {
		roleIDs = *input.RoleIDs
	}
	if input.CompanyIDs != nil {
		companyIDs = *input.CompanyIDs
	}
	updated, err := q.UpdateIAMUser(ctx, dbgen.UpdateIAMUserParams{ID: id, Name: text(after.Name)})
	if err != nil {
		return User{}, mapWriteError("更新用户失败", err)
	}
	after = userFromUpdate(updated)
	if input.RoleIDs != nil || input.CompanyIDs != nil {
		if err := replaceAccess(ctx, q, id, roleIDs, companyIDs); err != nil {
			return User{}, mapWriteError("保存用户角色/公司失败", err)
		}
	}
	changes := audit.Diff(userSnapshot(before, accessRoleIDs(access), accessCompanyIDs(access)), userSnapshot(after, roleIDs, companyIDs), userAuditFields)
	if len(changes) > 0 {
		if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_user", RecordID: id, RecordLabel: after.Username, ActionType: "update", ActionName: "update", Changes: changes}); err != nil {
			return User{}, apierror.Wrap(apierror.CodeInternal, "更新用户失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, mapWriteError("更新用户失败", err)
	}
	return after, nil
}

func (s *Service) UserAccess(ctx context.Context, id uuid.UUID) (UserAccess, error) {
	if _, err := dbgen.New(s.pool).GetIAMUser(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return UserAccess{}, apierror.New(apierror.CodeNotFound, "用户不存在")
	} else if err != nil {
		return UserAccess{}, apierror.Wrap(apierror.CodeInternal, "读取用户失败", err)
	}
	return accessWith(dbgen.New(s.pool), ctx, id)
}

func (s *Service) ResetPassword(ctx context.Context, actor *authz.Actor, id uuid.UUID) (string, error) {
	password, err := randomPassword()
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "生成随机密码失败", err)
	}
	hash, err := s.hasher.Hash(password)
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "生成密码哈希失败", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "重置密码失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	user, err := q.LockIAMUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apierror.New(apierror.CodeNotFound, "用户不存在")
	}
	if err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "重置密码失败", err)
	}
	if err := q.UpdateIAMUserPassword(ctx, dbgen.UpdateIAMUserPasswordParams{ID: id, HashedPassword: hash}); err != nil {
		return "", mapWriteError("重置密码失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_user", RecordID: id, RecordLabel: user.Username, ActionType: "update", ActionName: "reset_password", Changes: map[string]audit.Change{}}); err != nil {
		return "", apierror.Wrap(apierror.CodeInternal, "重置密码失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", mapWriteError("重置密码失败", err)
	}
	return password, nil
}

func (s *Service) DeleteUser(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除用户失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockIAMUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "用户不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除用户失败", err)
	}
	item := userFromLock(row)
	if err := q.DeleteUserRoles(ctx, id); err != nil {
		return mapWriteError("删除用户失败", err)
	}
	if err := q.DeleteUserCompanies(ctx, id); err != nil {
		return mapWriteError("删除用户失败", err)
	}
	if _, err := q.DeleteIAMUser(ctx, id); err != nil {
		return mapWriteError("删除用户失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_user", RecordID: id, RecordLabel: item.Username, ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(userSnapshot(item, nil, nil), []string{"username", "name", "preferred_language"})}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除用户失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("删除用户失败", err)
	}
	return nil
}

func (s *Service) GetRole(ctx context.Context, id uuid.UUID) (Role, error) {
	row, err := dbgen.New(s.pool).GetIAMRole(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apierror.New(apierror.CodeNotFound, "角色不存在")
	}
	if err != nil {
		return Role{}, apierror.Wrap(apierror.CodeInternal, "读取角色失败", err)
	}
	return roleFromGet(row), nil
}

func (s *Service) ListRoles(ctx context.Context, query ListQuery) (RoleList, error) {
	if err := validatePage(&query); err != nil {
		return RoleList{}, err
	}
	built, err := filterbuild.Build(RoleResourceMeta(), filterbuild.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter})
	if err != nil {
		return RoleList{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "code" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return RoleList{}, apierror.Wrap(apierror.CodeInternal, "查询角色失败", err)
	}
	defer tx.Rollback(ctx)
	var result RoleList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sys_role`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return RoleList{}, apierror.Wrap(apierror.CodeInternal, "统计角色失败", err)
	}
	args, limitAt := append([]any(nil), built.Args...), len(built.Args)+1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id, code, name, enabled, builtin, inserted_at, updated_at FROM sys_role`+built.Where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), args...)
	if err != nil {
		return RoleList{}, apierror.Wrap(apierror.CodeInternal, "查询角色失败", err)
	}
	defer rows.Close()
	result.Results = make([]Role, 0, query.Limit)
	for rows.Next() {
		var item Role
		if err := rows.Scan(&item.ID, &item.Code, &item.Name, &item.Enabled, &item.Builtin, &item.InsertedAt, &item.UpdatedAt); err != nil {
			return RoleList{}, apierror.Wrap(apierror.CodeInternal, "读取角色结果失败", err)
		}
		item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return RoleList{}, apierror.Wrap(apierror.CodeInternal, "遍历角色结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RoleList{}, apierror.Wrap(apierror.CodeInternal, "完成角色查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateRole(ctx context.Context, actor *authz.Actor, input RoleCreate) (Role, error) {
	if err := normalizeRoleCreate(&input); err != nil {
		return Role{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, apierror.Wrap(apierror.CodeInternal, "创建角色失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).CreateIAMRole(ctx, dbgen.CreateIAMRoleParams{Code: input.Code, Name: input.Name, Enabled: enabled})
	if err != nil {
		return Role{}, mapWriteError("创建角色失败", err)
	}
	item := roleFromCreate(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_role", RecordID: item.ID, RecordLabel: item.Name, ActionType: "create", ActionName: "create", Changes: audit.Created(roleSnapshot(item), roleAuditFields)}); err != nil {
		return Role{}, apierror.Wrap(apierror.CodeInternal, "创建角色失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, mapWriteError("创建角色失败", err)
	}
	return item, nil
}

func (s *Service) UpdateRole(ctx context.Context, actor *authz.Actor, id uuid.UUID, input RoleUpdate) (Role, error) {
	if err := normalizeRoleUpdate(&input); err != nil {
		return Role{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Role{}, apierror.Wrap(apierror.CodeInternal, "更新角色失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockIAMRole(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Role{}, apierror.New(apierror.CodeNotFound, "角色不存在")
	}
	if err != nil {
		return Role{}, apierror.Wrap(apierror.CodeInternal, "更新角色失败", err)
	}
	before := roleFromLock(row)
	if before.Builtin {
		return Role{}, apierror.New(apierror.CodeConflict, "内置角色不可修改或删除")
	}
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.Enabled != nil {
		after.Enabled = *input.Enabled
	}
	updated, err := q.UpdateIAMRole(ctx, dbgen.UpdateIAMRoleParams{ID: id, Name: after.Name, Enabled: after.Enabled})
	if err != nil {
		return Role{}, mapWriteError("更新角色失败", err)
	}
	after = roleFromUpdate(updated)
	changes := audit.Diff(roleSnapshot(before), roleSnapshot(after), roleAuditFields)
	if len(changes) > 0 {
		if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_role", RecordID: id, RecordLabel: after.Name, ActionType: "update", ActionName: "update", Changes: changes}); err != nil {
			return Role{}, apierror.Wrap(apierror.CodeInternal, "更新角色失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Role{}, mapWriteError("更新角色失败", err)
	}
	return after, nil
}

func (s *Service) DeleteRole(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除角色失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockIAMRole(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "角色不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除角色失败", err)
	}
	item := roleFromLock(row)
	if item.Builtin {
		return apierror.New(apierror.CodeConflict, "内置角色不可修改或删除")
	}
	if _, err := q.DeleteIAMRole(ctx, id); err != nil {
		return mapWriteError("删除角色失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_role", RecordID: id, RecordLabel: item.Name, ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(roleSnapshot(item), roleAuditFields)}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除角色失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("删除角色失败", err)
	}
	return nil
}

func (s *Service) RolePermissions(ctx context.Context, roleID uuid.UUID) (RolePermissions, error) {
	if _, err := dbgen.New(s.pool).GetIAMRole(ctx, roleID); errors.Is(err, pgx.ErrNoRows) {
		return RolePermissions{}, apierror.New(apierror.CodeNotFound, "角色不存在")
	} else if err != nil {
		return RolePermissions{}, apierror.Wrap(apierror.CodeInternal, "读取角色失败", err)
	}
	rows, err := dbgen.New(s.pool).GetRolePermissions(ctx, roleID)
	if err != nil {
		return RolePermissions{}, apierror.Wrap(apierror.CodeInternal, "读取角色权限失败", err)
	}
	result := RolePermissions{Rows: make([]GrantedPermission, 0, len(rows))}
	for _, row := range rows {
		result.Rows = append(result.Rows, GrantedPermission{ID: row.ID, Permission: row.Permission})
	}
	return result, nil
}

func (s *Service) SyncRolePermissions(ctx context.Context, actor *authz.Actor, roleID uuid.UUID, desired []string) ([]string, error) {
	catalog := make(map[string]struct{})
	for _, group := range s.registry.PermissionCatalog() {
		for _, action := range group.Actions {
			catalog[group.Prefix+":"+action] = struct{}{}
		}
	}
	desired = uniqueStrings(desired)
	for _, code := range desired {
		if _, ok := catalog[code]; !ok {
			return nil, apierror.Validation("权限码不合法", map[string][]string{"permissions": {"包含目录外权限码: " + code}})
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "同步角色权限失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	roleRow, err := q.LockIAMRole(ctx, roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apierror.New(apierror.CodeNotFound, "角色不存在")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "同步角色权限失败", err)
	}
	role := roleFromLock(roleRow)
	if role.Builtin {
		return nil, apierror.New(apierror.CodeConflict, "内置角色的授权不可增删")
	}
	existing, err := q.GetRolePermissions(ctx, roleID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "同步角色权限失败", err)
	}
	wanted := setStrings(desired)
	remove := make([]string, 0)
	before := make([]string, 0, len(existing))
	final := make([]string, 0, len(existing)+len(desired))
	for _, row := range existing {
		before = append(before, row.Permission)
		if _, inCatalog := catalog[row.Permission]; inCatalog {
			if _, keep := wanted[row.Permission]; !keep {
				remove = append(remove, row.Permission)
				continue
			}
		}
		final = append(final, row.Permission)
	}
	if len(remove) > 0 {
		if err := q.DeleteRolePermissions(ctx, dbgen.DeleteRolePermissionsParams{RoleID: roleID, Permissions: remove}); err != nil {
			return nil, mapWriteError("同步角色权限失败", err)
		}
	}
	if len(desired) > 0 {
		if err := q.InsertRolePermissions(ctx, dbgen.InsertRolePermissionsParams{RoleID: roleID, Permissions: desired}); err != nil {
			return nil, mapWriteError("同步角色权限失败", err)
		}
	}
	for _, code := range desired {
		if !contains(final, code) {
			final = append(final, code)
		}
	}
	sort.Strings(before)
	sort.Strings(final)
	if strings.Join(before, "\x00") != strings.Join(final, "\x00") {
		changes := map[string]audit.Change{"permissions": {"from": before, "to": final}}
		if err := audit.Write(ctx, tx, actor, audit.Entry{Resource: "sys_role_permission", RecordID: roleID, RecordLabel: role.Name, ActionType: "update", ActionName: "sync", Changes: changes}); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "同步角色权限失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapWriteError("同步角色权限失败", err)
	}
	return final, nil
}

var userAuditFields = []string{"username", "name", "preferred_language", "role_ids", "company_ids"}
var roleAuditFields = []string{"code", "name", "enabled", "builtin"}

func validatePage(q *ListQuery) error {
	if q.Limit == 0 {
		q.Limit = 20
	}
	fields := map[string][]string{}
	if q.Limit < 1 || q.Limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if q.Offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) > 0 {
		return apierror.Validation("分页参数不合法", fields)
	}
	return nil
}
func normalizeUserCreate(in *UserCreate) error {
	in.Username = strings.TrimSpace(in.Username)
	in.RoleIDs = uniqueUUIDs(in.RoleIDs)
	in.CompanyIDs = uniqueUUIDs(in.CompanyIDs)
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" {
			in.Name = nil
		} else {
			in.Name = &n
		}
	}
	fields := map[string][]string{}
	if in.Username == "" || utf8.RuneCountInString(in.Username) > 64 {
		fields["username"] = []string{"必填且最多 64 个字符"}
	}
	if in.Name != nil && utf8.RuneCountInString(*in.Name) > 64 {
		fields["name"] = []string{"最多 64 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("用户参数不合法", fields)
	}
	return nil
}
func normalizeUserUpdate(in *UserUpdate) error {
	if in.Name != nil && *in.Name != nil {
		n := strings.TrimSpace(**in.Name)
		if n == "" {
			*in.Name = nil
		} else {
			*in.Name = &n
		}
		if *in.Name != nil && utf8.RuneCountInString(**in.Name) > 64 {
			return apierror.Validation("用户参数不合法", map[string][]string{"name": {"最多 64 个字符"}})
		}
	}
	if in.RoleIDs != nil {
		v := uniqueUUIDs(*in.RoleIDs)
		in.RoleIDs = &v
	}
	if in.CompanyIDs != nil {
		v := uniqueUUIDs(*in.CompanyIDs)
		in.CompanyIDs = &v
	}
	return nil
}
func normalizeRoleCreate(in *RoleCreate) error {
	in.Code, in.Name = strings.TrimSpace(in.Code), strings.TrimSpace(in.Name)
	fields := map[string][]string{}
	if in.Code == "" || utf8.RuneCountInString(in.Code) > 64 {
		fields["code"] = []string{"必填且最多 64 个字符"}
	}
	if in.Name == "" || utf8.RuneCountInString(in.Name) > 64 {
		fields["name"] = []string{"必填且最多 64 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("角色参数不合法", fields)
	}
	return nil
}
func normalizeRoleUpdate(in *RoleUpdate) error {
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		in.Name = &n
		if n == "" || utf8.RuneCountInString(n) > 64 {
			return apierror.Validation("角色参数不合法", map[string][]string{"name": {"必填且最多 64 个字符"}})
		}
	}
	return nil
}
func randomPassword() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
func replaceAccess(ctx context.Context, q *dbgen.Queries, id uuid.UUID, roles, companies []uuid.UUID) error {
	if err := q.DeleteUserRoles(ctx, id); err != nil {
		return err
	}
	if len(roles) > 0 {
		if err := q.InsertUserRoles(ctx, dbgen.InsertUserRolesParams{UserID: id, RoleIds: roles}); err != nil {
			return err
		}
	}
	if err := q.DeleteUserCompanies(ctx, id); err != nil {
		return err
	}
	if len(companies) > 0 {
		return q.InsertUserCompanies(ctx, dbgen.InsertUserCompaniesParams{UserID: id, CompanyIds: companies})
	}
	return nil
}
func accessWith(q *dbgen.Queries, ctx context.Context, id uuid.UUID) (UserAccess, error) {
	roles, err := q.UserAccessRoles(ctx, id)
	if err != nil {
		return UserAccess{}, apierror.Wrap(apierror.CodeInternal, "读取用户角色失败", err)
	}
	companies, err := q.UserAccessCompanies(ctx, id)
	if err != nil {
		return UserAccess{}, apierror.Wrap(apierror.CodeInternal, "读取用户公司失败", err)
	}
	r := UserAccess{Roles: make([]AccessItem, 0, len(roles)), Companies: make([]AccessItem, 0, len(companies))}
	for _, x := range roles {
		r.Roles = append(r.Roles, AccessItem{ID: x.RoleID, Name: x.Name})
	}
	for _, x := range companies {
		r.Companies = append(r.Companies, AccessItem{ID: x.CompanyID, Name: x.Name})
	}
	return r, nil
}
func accessIDs(a UserAccess) ([]uuid.UUID, []uuid.UUID) { return accessRoleIDs(a), accessCompanyIDs(a) }
func accessRoleIDs(a UserAccess) []uuid.UUID {
	r := make([]uuid.UUID, len(a.Roles))
	for i, x := range a.Roles {
		r[i] = x.ID
	}
	return r
}
func accessCompanyIDs(a UserAccess) []uuid.UUID {
	r := make([]uuid.UUID, len(a.Companies))
	for i, x := range a.Companies {
		r[i] = x.ID
	}
	return r
}
func uniqueUUIDs(v []uuid.UUID) []uuid.UUID {
	m := map[uuid.UUID]struct{}{}
	r := make([]uuid.UUID, 0, len(v))
	for _, x := range v {
		if x == uuid.Nil {
			continue
		}
		if _, ok := m[x]; !ok {
			m[x] = struct{}{}
			r = append(r, x)
		}
	}
	sort.Slice(r, func(i, j int) bool { return r[i].String() < r[j].String() })
	return r
}
func uniqueStrings(v []string) []string {
	m := map[string]struct{}{}
	r := make([]string, 0, len(v))
	for _, x := range v {
		x = strings.TrimSpace(x)
		if x == "" {
			continue
		}
		if _, ok := m[x]; !ok {
			m[x] = struct{}{}
			r = append(r, x)
		}
	}
	sort.Strings(r)
	return r
}
func setStrings(v []string) map[string]struct{} {
	m := make(map[string]struct{}, len(v))
	for _, x := range v {
		m[x] = struct{}{}
	}
	return m
}
func contains(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}
func text(v *string) pgtype.Text {
	if v == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *v, Valid: true}
}
func textPtr(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	x := v.String
	return &x
}
func userFromGet(r dbgen.GetIAMUserRow) User {
	return User{ID: r.ID, Username: r.Username, Name: textPtr(r.Name), PreferredLanguage: textPtr(r.PreferredLanguage), InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func userFromLock(r dbgen.LockIAMUserRow) User {
	return User{ID: r.ID, Username: r.Username, Name: textPtr(r.Name), PreferredLanguage: textPtr(r.PreferredLanguage), InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func userFromCreate(r dbgen.CreateIAMUserRow) User {
	return User{ID: r.ID, Username: r.Username, Name: textPtr(r.Name), PreferredLanguage: textPtr(r.PreferredLanguage), InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func userFromUpdate(r dbgen.UpdateIAMUserRow) User {
	return User{ID: r.ID, Username: r.Username, Name: textPtr(r.Name), PreferredLanguage: textPtr(r.PreferredLanguage), InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func userSnapshot(u User, roles, companies []uuid.UUID) map[string]any {
	return map[string]any{"username": u.Username, "name": u.Name, "preferred_language": u.PreferredLanguage, "role_ids": roles, "company_ids": companies}
}
func roleFromGet(r dbgen.GetIAMRoleRow) Role {
	return Role{ID: r.ID, Code: r.Code, Name: r.Name, Enabled: r.Enabled, Builtin: r.Builtin, InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func roleFromLock(r dbgen.LockIAMRoleRow) Role {
	return Role{ID: r.ID, Code: r.Code, Name: r.Name, Enabled: r.Enabled, Builtin: r.Builtin, InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func roleFromCreate(r dbgen.CreateIAMRoleRow) Role {
	return Role{ID: r.ID, Code: r.Code, Name: r.Name, Enabled: r.Enabled, Builtin: r.Builtin, InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func roleFromUpdate(r dbgen.UpdateIAMRoleRow) Role {
	return Role{ID: r.ID, Code: r.Code, Name: r.Name, Enabled: r.Enabled, Builtin: r.Builtin, InsertedAt: r.InsertedAt.Time.UTC(), UpdatedAt: r.UpdatedAt.Time.UTC()}
}
func roleSnapshot(r Role) map[string]any {
	return map[string]any{"code": r.Code, "name": r.Name, "enabled": r.Enabled, "builtin": r.Builtin}
}
func mapWriteError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "编码或关联已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "记录已被引用或关联目标不存在", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
