package unit

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "basUnits"

var auditedFields = []string{"unit_type", "is_base", "name", "symbol", "ratio"}
var unitTypes = []meta.EnumOption{{Value: "LENGTH", Label: "长度"}, {Value: "AREA", Label: "面积"}, {Value: "WEIGHT", Label: "重量"}, {Value: "QUANTITY", Label: "数量"}}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyBasUnit"
	return meta.ResourceMeta{Name: ResourceName, PermissionPrefix: "base.unit", PermissionLabel: "计量单位", Table: "bas_unit",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "unit_type", APIName: "unitType", DBColumn: "unit_type", Type: meta.TypeEnum, Label: "单位类型", Required: true, EnumOptions: unitTypes, Filterable: true, Sortable: true},
			{Name: "is_base", APIName: "isBase", DBColumn: "is_base", Type: meta.TypeBoolean, Label: "基准单位", Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "单位名称", Required: true, Filterable: true, Sortable: true},
			{Name: "symbol", APIName: "symbol", DBColumn: "symbol", Type: meta.TypeString, Label: "单位符号", Required: true, Filterable: true, Sortable: true},
			{Name: "ratio", APIName: "ratio", DBColumn: "ratio", Type: meta.TypeDecimal, Label: "换算比例", Required: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
		}, Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}, {Key: "create", Label: "新增", Scope: "both"}, {Key: "update", Label: "编辑", Scope: "row"}, {Key: "delete", Label: "删除", Scope: "row", IsDanger: true}},
		Form: &meta.FormMetaDTO{Exclude: []string{"id", "insertedAt", "updatedAt"}}, Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}
