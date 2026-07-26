package company

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "basCompanies"

var auditedFields = []string{"code", "name", "short_name", "parent_id", "base_currency_id"}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyBasCompany"
	companyResource, companyRelation, nameField := ResourceName, "parent", "name"
	currencyResource, currencyRelation := "basCurrencies", "baseCurrency"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "base.company", PermissionLabel: "公司", Table: "bas_company",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "公司编号", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "公司名称", Required: true, Filterable: true, Sortable: true},
			{Name: "short_name", APIName: "shortName", DBColumn: "short_name", Type: meta.TypeString, Label: "公司简称", Required: true, Filterable: true, Sortable: true},
			{Name: "parent_id", APIName: "parentId", DBColumn: "parent_id", Type: meta.TypeFK, Label: "上级公司", Filterable: true, Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "base_currency_id", APIName: "baseCurrencyId", DBColumn: "base_currency_id", Type: meta.TypeFK, Label: "本币", Required: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &currencyResource, Relation: &currencyRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"}, {Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"}, {Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{Exclude: []string{"id"}, Fields: map[string]map[string]any{
			"code": {"required": true, "edit": "createOnly", "placeholder": "两位英文字母,如 SH"},
			"name": {"required": true, "placeholder": "如 上海总部"}, "shortName": {"required": true, "placeholder": "如 上海"},
			"baseCurrencyId": {"required": true, "label": "本币"},
		}},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
