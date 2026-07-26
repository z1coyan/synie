package currency

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "basCurrencies"

var auditedFields = []string{"name", "iso_code", "symbol", "active"}

func ResourceMeta() meta.ResourceMeta {
	destroyMutation := "destroyBasCurrency"
	return meta.ResourceMeta{
		Name:             ResourceName,
		PermissionPrefix: "base.currency",
		PermissionLabel:  "币种",
		Table:            "bas_currency",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "货币名称", Required: true, Filterable: true, Sortable: true},
			{Name: "iso_code", APIName: "isoCode", DBColumn: "iso_code", Type: meta.TypeString, Label: "ISO 编码", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "symbol", APIName: "symbol", DBColumn: "symbol", Type: meta.TypeString, Label: "符号", Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
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
			Exclude: []string{"id", "active", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"name":    {"required": true, "placeholder": "如 人民币"},
				"isoCode": {"required": true, "edit": "createOnly", "placeholder": "三位大写字母,如 CNY"},
				"symbol":  {"placeholder": "如 ¥"},
			},
		},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroyMutation,
	}
}
