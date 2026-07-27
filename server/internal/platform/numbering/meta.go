package numbering

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	RuleResourceName    = "sysNumberingRules"
	CounterResourceName = "sysNumberingCounters"
)

func RuleResourceMeta() meta.ResourceMeta {
	destroy := "destroySysNumberingRule"
	return meta.ResourceMeta{
		Name: RuleResourceName, PermissionPrefix: "sys.numbering_rule",
		PermissionLabel: "编号规则", Table: "sys_numbering_rule",
		Print: true, PrintHead: true, Audit: meta.AuditMeta{Enabled: true},
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "resource", APIName: "resource", DBColumn: "resource", Type: meta.TypeString, Label: "绑定资源", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "规则名称", Required: true, Filterable: true, Sortable: true},
			{Name: "segments", APIName: "segments", DBColumn: "segments", Type: meta.TypeString, Label: "编号段", Required: true},
			{Name: "per_company", APIName: "perCompany", DBColumn: "per_company", Type: meta.TypeBoolean, Label: "按公司计数", Required: true, Filterable: true, Sortable: true},
			{Name: "enabled", APIName: "enabled", DBColumn: "enabled", Type: meta.TypeBoolean, Label: "启用", Required: true, Filterable: true, Sortable: true},
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
				"resource": {"edit": "createOnly"},
				"enabled":  {"defaultValue": true},
			},
		},
		DestroyMutation: &destroy,
	}
}

func CounterResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: CounterResourceName, PermissionPrefix: "sys.numbering_rule",
		PermissionLabel: "编号规则", Table: "sys_numbering_counter",
		Audit: meta.AuditMeta{Enabled: true},
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "scope_key", APIName: "scopeKey", DBColumn: "scope_key", Type: meta.TypeString, Label: "计数范围", Readonly: true, Filterable: true, Sortable: true},
			{Name: "value", APIName: "value", DBColumn: "value", Type: meta.TypeInteger, Label: "当前序号", Required: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "rule_id", APIName: "ruleId", DBColumn: "rule_id", Type: meta.TypeUUID, Label: "编号规则", Required: true, Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{
					Resource: metaText(RuleResourceName), Relation: metaText("rule"), LabelField: metaText("name"),
				}},
		},
		Form: &meta.FormMetaDTO{Exclude: []string{"id", "ruleId", "scopeKey", "insertedAt", "updatedAt"}},
	}
}

func metaText(value string) *string { return &value }
