package supplier

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "purSuppliers"

var auditedFields = []string{"code", "name", "short_name"}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurSupplier"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "purchase.supplier",
		PermissionLabel: "供应商", Table: "pur_supplier",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "供应商编号", Required: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "供应商名称", Required: true, Filterable: true, Sortable: true},
			{Name: "short_name", APIName: "shortName", DBColumn: "short_name", Type: meta.TypeString, Label: "简称", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"code":      {"required": true, "placeholder": "如 S0001"},
				"name":      {"required": true, "placeholder": "供应商全称"},
				"shortName": {"placeholder": "如 富士康"},
			},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
