package account

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "basAccounts"

var directionOptions = []meta.EnumOption{
	{Value: "DEBIT", Label: "借"},
	{Value: "CREDIT", Label: "贷"},
}

var roleOptions = []meta.EnumOption{
	{Value: "UNBILLED_RECEIVABLE", Label: "未开票应收"},
	{Value: "RECEIVABLE", Label: "应收账款"},
	{Value: "ADVANCE_RECEIVED", Label: "预收款"},
	{Value: "UNBILLED_PAYABLE", Label: "未开票应付"},
	{Value: "PAYABLE", Label: "应付账款"},
	{Value: "OTHER_PAYABLE", Label: "其他应付款"},
	{Value: "ADVANCE_PAID", Label: "预付款"},
	{Value: "TRAVEL", Label: "差旅费"},
	{Value: "OFFICE", Label: "办公费"},
	{Value: "ENTERTAINMENT", Label: "业务招待费"},
	{Value: "TRANSPORT", Label: "交通费"},
	{Value: "OTHER_EXPENSE", Label: "其他费用"},
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyBasAccount"
	accountResource, accountRelation, nameField := ResourceName, "parent", "name"
	companyResource, companyRelation := "basCompanies", "company"
	currencyResource, currencyRelation := "basCurrencies", "currency"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "base.account", PermissionLabel: "会计科目", Table: "bas_account",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "科目编码", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "科目名称", Required: true, Filterable: true, Sortable: true},
			{Name: "direction", APIName: "direction", DBColumn: "direction", Type: meta.TypeEnum, Label: "余额方向", Required: true, EnumOptions: directionOptions, Filterable: true, Sortable: true},
			{Name: "is_group", APIName: "isGroup", DBColumn: "is_group", Type: meta.TypeBoolean, Label: "汇总科目", Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			{Name: "role", APIName: "role", DBColumn: "role", Type: meta.TypeEnum, Label: "科目角色", EnumOptions: roleOptions, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "parent_id", APIName: "parentId", DBColumn: "parent_id", Type: meta.TypeFK, Label: "上级科目", Filterable: true, Ref: &meta.GridColumnRef{Resource: &accountResource, Relation: &accountRelation, LabelField: &nameField}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Filterable: true, Ref: &meta.GridColumnRef{Resource: &currencyResource, Relation: &currencyRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{Exclude: []string{"id", "insertedAt", "updatedAt"}, Fields: map[string]map[string]any{
			"code":      {"required": true, "edit": "createOnly"},
			"companyId": {"required": true, "edit": "createOnly"},
		}},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
