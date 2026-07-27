package master

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	OperationResourceName    = "mfgOperations"
	TemplateResourceName     = "mfgProcessTemplates"
	TemplateItemResourceName = "mfgProcessTemplateItems"
	BOMResourceName          = "mfgBoms"
	ComponentResourceName    = "mfgBomComponents"
	RouteResourceName        = "mfgBomRoutes"
	ByproductResourceName    = "mfgBomByproducts"
)

func OperationResourceMeta() meta.ResourceMeta {
	return headResourceMeta(OperationResourceName, operationPermission, "工序",
		"mfg_operation", "工序编号", "工序名称", "destroyMfgOperation")
}

func TemplateResourceMeta() meta.ResourceMeta {
	resource := headResourceMeta(TemplateResourceName, templatePermission, "工艺模板",
		"mfg_process_template", "模板编号", "模板名称", "destroyMfgProcessTemplate")
	resource.PrintHead = true
	resource.PrintLoops = []meta.PrintLoopMeta{{Name: "items", Resource: TemplateItemResourceName}}
	return resource
}

func TemplateItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgProcessTemplateItem"
	return meta.ResourceMeta{
		Name: TemplateItemResourceName, PermissionPrefix: templatePermission,
		PermissionLabel: "工艺模板", Table: "mfg_process_template_item",
		Fields: append(routeFields(),
			fkField("template_id", "templateId", "工艺模板", TemplateResourceName, "template", "name", true),
			fkField("operation_id", "operationId", "工序", OperationResourceName, "operation", "name", false),
		),
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"templateId":  {"required": true},
				"operationId": {"required": true},
				"seq":         {"required": true},
			},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BOMResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgBom"
	return meta.ResourceMeta{
		Name: BOMResourceName, PermissionPrefix: bomPermission,
		PermissionLabel: "BOM", Table: "mfg_bom",
		Fields: []meta.FieldMeta{
			idField(),
			stringField("code", "code", "编号", true, true),
			stringField("plan_name", "planName", "方案名称", false, false),
			stringField("note", "note", "备注", false, false),
			timeField("inserted_at", "insertedAt", "创建时间"),
			timeField("updated_at", "updatedAt", "更新时间"),
			fkField("material_id", "materialId", "物料", "invMaterials", "material", "name", true),
		},
		Actions: headActions(),
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"code":       {"placeholder": "留空自动取号"},
				"materialId": {"required": true},
			},
		},
		Print:     true,
		PrintHead: true,
		PrintLoops: []meta.PrintLoopMeta{
			{Name: "byproducts", Resource: ByproductResourceName},
			{Name: "components", Resource: ComponentResourceName},
			{Name: "routes", Resource: RouteResourceName},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ComponentResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgBomComponent"
	return meta.ResourceMeta{
		Name: ComponentResourceName, PermissionPrefix: bomPermission,
		PermissionLabel: "BOM", Table: "mfg_bom_component",
		Fields: []meta.FieldMeta{
			idField(),
			decimalField("quantity", "quantity", "单位净用量(每 1 默认单位母物料)", true),
			decimalField("loss_rate", "lossRate", "损耗率(空即无损耗)", false),
			stringField("note", "note", "备注", false, false),
			timeField("inserted_at", "insertedAt", "创建时间"),
			timeField("updated_at", "updatedAt", "更新时间"),
			fkField("bom_id", "bomId", "BOM", BOMResourceName, "bom", "code", true),
			fkField("material_id", "materialId", "子物料", "invMaterials", "material", "name", false),
			fkField("unit_id", "unitId", "单位", "basUnits", "unit", "name", false),
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"bomId":      {"required": true},
				"materialId": {"required": true},
				"unitId":     {"required": true},
				"quantity":   {"required": true},
			},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func RouteResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgBomRoute"
	return meta.ResourceMeta{
		Name: RouteResourceName, PermissionPrefix: bomPermission,
		PermissionLabel: "BOM", Table: "mfg_bom_route",
		Fields: append(routeFields(),
			fkField("bom_id", "bomId", "BOM", BOMResourceName, "bom", "code", true),
			fkField("operation_id", "operationId", "工序", OperationResourceName, "operation", "name", false),
		),
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"bomId":       {"required": true},
				"operationId": {"required": true},
				"seq":         {"required": true},
			},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ByproductResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgBomByproduct"
	return meta.ResourceMeta{
		Name: ByproductResourceName, PermissionPrefix: bomPermission,
		PermissionLabel: "BOM", Table: "mfg_bom_byproduct",
		Fields: []meta.FieldMeta{
			idField(),
			decimalField("quantity", "quantity", "单位产出量(每 1 默认单位母物料)", true),
			stringField("note", "note", "备注", false, false),
			timeField("inserted_at", "insertedAt", "创建时间"),
			timeField("updated_at", "updatedAt", "更新时间"),
			fkField("bom_id", "bomId", "BOM", BOMResourceName, "bom", "code", true),
			fkField("material_id", "materialId", "副产品物料", "invMaterials", "material", "name", false),
			fkField("unit_id", "unitId", "单位", "basUnits", "unit", "name", false),
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"bomId":      {"required": true},
				"materialId": {"required": true},
				"unitId":     {"required": true},
				"quantity":   {"required": true},
			},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func headResourceMeta(name, permission, label, table, codeLabel, nameLabel, mutation string) meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: name, PermissionPrefix: permission, PermissionLabel: label, Table: table,
		Fields: []meta.FieldMeta{
			idField(),
			stringField("code", "code", codeLabel, true, true),
			stringField("name", "name", nameLabel, true, false),
			stringField("note", "note", "备注", false, false),
			timeField("inserted_at", "insertedAt", "创建时间"),
			timeField("updated_at", "updatedAt", "更新时间"),
		},
		Actions: headActions(),
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"code": {"placeholder": "留空自动取号"},
				"name": {"required": true},
			},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &mutation,
	}
}

func headActions() []meta.ActionMeta {
	return []meta.ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"},
		{Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"},
		{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
	}
}

func routeFields() []meta.FieldMeta {
	return []meta.FieldMeta{
		idField(),
		{Name: "seq", APIName: "seq", DBColumn: "seq", Type: meta.TypeInteger,
			Label: "工序顺序", Required: true, Filterable: true, Sortable: true},
		stringField("requirement", "requirement", "工艺要求", false, false),
		{Name: "is_outsourced", APIName: "isOutsourced", DBColumn: "is_outsourced",
			Type: meta.TypeBoolean, Label: "外协标记", Required: true, Filterable: true, Sortable: true},
		timeField("inserted_at", "insertedAt", "创建时间"),
		timeField("updated_at", "updatedAt", "更新时间"),
	}
}

func idField() meta.FieldMeta {
	return meta.FieldMeta{Name: "id", APIName: "id", DBColumn: "id",
		Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true}
}

func stringField(name, apiName, label string, required, createOnly bool) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: apiName, DBColumn: name,
		Type: meta.TypeString, Label: label, Required: required, CreateOnly: createOnly,
		Filterable: true, Sortable: true}
}

func decimalField(name, apiName, label string, required bool) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: apiName, DBColumn: name,
		Type: meta.TypeDecimal, Label: label, Required: required, Filterable: true, Sortable: true}
}

func timeField(name, apiName, label string) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: apiName, DBColumn: name,
		Type: meta.TypeDatetime, Label: label, Readonly: true, Filterable: true, Sortable: true}
}

func fkField(name, apiName, label, resource, relation, labelField string, createOnly bool) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: apiName, DBColumn: name, Type: meta.TypeFK,
		Label: label, Required: true, CreateOnly: createOnly, Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}
