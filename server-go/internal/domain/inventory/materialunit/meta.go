package materialunit

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "invMaterialUnits"

var auditedFields = []string{"factor", "material_id", "unit_id"}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvMaterialUnit"
	materialResource, materialRelation := "invMaterials", "material"
	unitResource, unitRelation := "basUnits", "unit"
	nameField := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.material",
		PermissionLabel: "物料", Table: "inv_material_unit",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "factor", APIName: "factor", DBColumn: "factor", Type: meta.TypeDecimal, Label: "换算系数(1 默认单位 = x 该单位)", Required: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &materialResource, Relation: &materialRelation, LabelField: &nameField}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "单位", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &nameField}},
		},
		// The child resource has CRUD endpoints but intentionally exposes no
		// standalone Grid capabilities; edits are part of inv.material.
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields: map[string]map[string]any{
				"materialId": {"required": true},
				"unitId":     {"required": true},
				"factor":     {"required": true, "placeholder": "1 默认单位 = x 该单位"},
			},
		},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
