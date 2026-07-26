package material

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "invMaterials"

var auditedFields = []string{
	"code", "name", "spec", "customer_part_no", "is_customer_material", "active",
	"category_id", "default_unit_id", "customer_id",
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvMaterial"
	categoryResource, categoryRelation := "invMaterialCategories", "category"
	unitResource, unitRelation := "basUnits", "defaultUnit"
	customerResource, customerRelation := "salCustomers", "customer"
	nameField := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.material",
		PermissionLabel: "物料", Table: "inv_material",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "物料编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "物料名称", Required: true, Filterable: true, Sortable: true},
			{Name: "spec", APIName: "spec", DBColumn: "spec", Type: meta.TypeString, Label: "物料规格", Filterable: true, Sortable: true},
			{Name: "customer_part_no", APIName: "customerPartNo", DBColumn: "customer_part_no", Type: meta.TypeString, Label: "客户方产品编号(仅客户物料可填)", Filterable: true, Sortable: true},
			{Name: "is_customer_material", APIName: "isCustomerMaterial", DBColumn: "is_customer_material", Type: meta.TypeBoolean, Label: "是否客户物料", Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "category_id", APIName: "categoryId", DBColumn: "category_id", Type: meta.TypeFK, Label: "物料分类", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &categoryResource, Relation: &categoryRelation, LabelField: &nameField}},
			{Name: "default_unit_id", APIName: "defaultUnitId", DBColumn: "default_unit_id", Type: meta.TypeFK, Label: "默认单位", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &nameField}},
			{Name: "customer_id", APIName: "customerId", DBColumn: "customer_id", Type: meta.TypeFK, Label: "所属客户(仅客户物料)", Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &customerResource, Relation: &customerRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"active"},
			Fields: map[string]map[string]any{
				"code":               {"edit": "readOnly", "placeholder": "保存后自动编号(分类号[客户号]-序号)"},
				"name":               {"required": true},
				"categoryId":         {"required": true},
				"defaultUnitId":      {"required": true},
				"isCustomerMaterial": {"defaultValue": false},
			},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
