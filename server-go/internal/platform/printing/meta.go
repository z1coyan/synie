package printing

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "sysPrintTemplates"

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroySysPrintTemplate"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "sys.print_template",
		PermissionLabel: "打印模板", Table: "sys_print_template",
		Print: true, Audit: meta.AuditMeta{Enabled: true},
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "模板名称", Required: true, Filterable: true, Sortable: true},
			{Name: "resource", APIName: "resource", DBColumn: "resource", Type: meta.TypeString, Label: "绑定资源", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "is_default", APIName: "isDefault", DBColumn: "is_default", Type: meta.TypeBoolean, Label: "默认模板", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "file_id", APIName: "fileId", DBColumn: "file_id", Type: meta.TypeUUID, Label: "模板文件", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{
					Resource: metaString("sysFiles"), Relation: metaString("file"), LabelField: metaString("filename"),
				}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "isDefault", "insertedAt", "updatedAt"},
			Fields:  map[string]map[string]any{"resource": {"edit": "createOnly"}},
		},
		DestroyMutation: &destroy,
	}
}

func metaString(value string) *string { return &value }
