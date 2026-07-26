package iam

import "github.com/z1coyan/synie/server/internal/platform/meta"

const UserResourceName = "sysUsers"
const RoleResourceName = "sysRoles"
const RolePermissionResourceName = "sysRolePermissions"

func UserResourceMeta() meta.ResourceMeta {
	destroy := "destroySysUser"
	return meta.ResourceMeta{
		Name: UserResourceName, PermissionPrefix: "sys.user", PermissionLabel: "用户", Table: "sys_user",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "username", APIName: "username", DBColumn: "username", Type: meta.TypeString, Label: "用户名", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "姓名", Filterable: true, Sortable: true},
			{Name: "preferred_language", APIName: "preferredLanguage", DBColumn: "preferred_language", Type: meta.TypeString, Label: "首选语言", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		},
		Actions: crudActions(false),
		Form: &meta.FormMetaDTO{Exclude: []string{"id", "preferredLanguage", "insertedAt", "updatedAt"}, Fields: map[string]map[string]any{
			"username": {"required": true, "edit": "createOnly", "placeholder": "如 zhangsan"},
			"name":     {"placeholder": "如 张三"},
		}},
		Audit: meta.AuditMeta{Enabled: true, SensitiveFields: []string{"hashed_password"}}, DestroyMutation: &destroy,
	}
}

func RoleResourceMeta() meta.ResourceMeta {
	destroy := "destroySysRole"
	return meta.ResourceMeta{
		Name: RoleResourceName, PermissionPrefix: "sys.role", PermissionLabel: "角色", Table: "sys_role",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "角色编码", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "角色名称", Required: true, Filterable: true, Sortable: true},
			{Name: "enabled", APIName: "enabled", DBColumn: "enabled", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			{Name: "builtin", APIName: "builtin", DBColumn: "builtin", Type: meta.TypeBoolean, Label: "内置角色", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"}, {Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"}, {Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "batch_delete", Label: "批量删除", Scope: "bulk", IsDanger: true}, {Key: "export", Label: "导出", Scope: "both"},
			{Key: "print", Label: "打印", Scope: "row"}, {Key: "batch_print", Label: "批量打印", Scope: "bulk"},
		},
		Form: &meta.FormMetaDTO{Exclude: []string{"id", "enabled", "builtin", "insertedAt", "updatedAt"}, Fields: map[string]map[string]any{
			"code": {"required": true, "edit": "createOnly"}, "name": {"required": true},
		}},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func RolePermissionResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: RolePermissionResourceName, PermissionPrefix: "sys.role_permission", PermissionLabel: "角色权限", Table: "sys_role_permission",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "role_id", APIName: "roleId", DBColumn: "role_id", Type: meta.TypeUUID, Label: "角色", Required: true, Filterable: true, Sortable: true},
			{Name: "permission", APIName: "permission", DBColumn: "permission", Type: meta.TypeString, Label: "权限码", Required: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Sortable: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "授权", Scope: "both"},
			{Key: "delete", Label: "撤销", Scope: "row", IsDanger: true},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true},
	}
}

func crudActions(_ bool) []meta.ActionMeta {
	return []meta.ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"}, {Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"}, {Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
	}
}
