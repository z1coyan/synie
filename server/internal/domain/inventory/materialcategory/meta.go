package materialcategory

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "invMaterialCategories"

var auditedFields = []string{"code", "name", "is_leaf", "active", "parent_id"}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvMaterialCategory"
	resource, relation, labelField := ResourceName, "parent", "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.material_category",
		PermissionLabel: "物料分类", Table: "inv_material_category",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "分类编号", Required: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "分类名称", Required: true, Filterable: true, Sortable: true},
			{Name: "is_leaf", APIName: "isLeaf", DBColumn: "is_leaf", Type: meta.TypeBoolean, Label: "叶子分类", Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			// 旧打印目录的聚合字段（存在下级分类），仅打印可见
			{Name: "has_children", APIName: "hasChildren", DBColumn: "has_children", Type: meta.TypeBoolean, Label: "含下级分类", Calculated: true, PrintOnly: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "parent_id", APIName: "parentId", DBColumn: "parent_id", Type: meta.TypeFK, Label: "上级分类", Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &resource, Relation: &relation, LabelField: &labelField}},
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
				"code":     {"required": true, "placeholder": "如 01、0101"},
				"name":     {"required": true, "placeholder": "如 原材料"},
				"isLeaf":   {"defaultValue": true},
				"parentId": {"label": "上级分类"},
			},
		},
		Print:      true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "children", Resource: ResourceName}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
