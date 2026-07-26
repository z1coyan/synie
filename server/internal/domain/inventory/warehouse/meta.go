package warehouse

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "invWarehouses"

var auditedFields = []string{
	"name", "is_leaf", "active", "is_outsourced", "party_type", "party_id",
	"allow_negative", "company_id", "parent_id", "account_id",
}

var partyTypeOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvWarehouse"
	warehouseResource, parentRelation := ResourceName, "parent"
	companyResource, companyRelation := "basCompanies", "company"
	accountResource, accountRelation := "basAccounts", "account"
	nameField := "name"
	discriminator, discriminatorType := "partyType", "enum"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.warehouse",
		PermissionLabel: "仓库", Table: "inv_warehouse",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "仓库名称", Required: true, Filterable: true, Sortable: true},
			{Name: "is_leaf", APIName: "isLeaf", DBColumn: "is_leaf", Type: meta.TypeBoolean, Label: "叶子仓库", Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			{Name: "is_outsourced", APIName: "isOutsourced", DBColumn: "is_outsourced", Type: meta.TypeBoolean, Label: "外协仓(货物存放在协作方处的我方仓,为是必挂协作方)", Filterable: true, Sortable: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Label: "协作方类型(供应商/内部公司;外协仓必填,非外协仓必须为空)", EnumOptions: partyTypeOptions, Filterable: true, Sortable: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "协作方(多态引用,随 party_type 判别;一仓绑一方)", Filterable: true,
				Ref: &meta.GridColumnRef{
					Discriminator: &discriminator, DiscriminatorType: &discriminatorType,
					Variants: []meta.GridColumnRefVariant{
						{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
						{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
					},
				}},
			{Name: "allow_negative", APIName: "allowNegative", DBColumn: "allow_negative", Type: meta.TypeBoolean, Label: "允许负库存(库存分录审核/作废的负库存校验逐仓跳过)", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "parent_id", APIName: "parentId", DBColumn: "parent_id", Type: meta.TypeFK, Label: "上级仓库", Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &parentRelation, LabelField: &nameField}},
			{Name: "account_id", APIName: "accountId", DBColumn: "account_id", Type: meta.TypeFK, Label: "关联科目", Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &accountResource, Relation: &accountRelation, LabelField: &nameField}},
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
				"name":          {"required": true},
				"isLeaf":        {"defaultValue": true},
				"isOutsourced":  {"defaultValue": false},
				"allowNegative": {"defaultValue": false},
				"companyId":     {"required": true, "edit": "createOnly"},
			},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
