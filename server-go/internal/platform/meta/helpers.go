package meta

// 本文件是资源 Meta 构建助手的一等公民实现，由历史上 order（f/enumF/ref/
// withRef）与 banking、hr-operations（idField/scalar/enum/ref/crudActions）
// 三套私有助手收敛而来。新代码应优先使用这些助手而不是纯字面量。

// Field 构造通用字段（order 的 f）。
func Field(name, api string, typ FieldType, label string, sortable, filterable, readonly bool) FieldMeta {
	return FieldMeta{Name: name, APIName: api, DBColumn: name, Type: typ, Label: label,
		Sortable: sortable, Filterable: filterable, Readonly: readonly}
}

// IDField 构造标准只读主键字段（banking/hr-operations 的 idField）。
func IDField() FieldMeta {
	return FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: TypeUUID,
		Label: "id", Readonly: true, Sortable: true,
	}
}

// ScalarField 构造只读标量字段（banking/hr-operations 的 scalar）。
func ScalarField(name, api string, typ FieldType, label string, filterable, sortable bool) FieldMeta {
	return Field(name, api, typ, label, sortable, filterable, true)
}

// EnumField 构造可排序可筛选的枚举字段：readonly=false 对应 order 的
// enumF（表单可编辑），readonly=true 对应 banking/hr-operations 的 enum
// （网格只读）。
func EnumField(name, api string, typ FieldType, label string, options []EnumOption, readonly bool) FieldMeta {
	value := Field(name, api, typ, label, true, true, readonly)
	value.EnumOptions = options
	return value
}

// Ref 构造网格引用描述（order 的 ref）。
func Ref(resource, relation, label string) *GridColumnRef {
	return &GridColumnRef{Resource: &resource, Relation: &relation, LabelField: &label}
}

// RefField 构造外键字段：readonly=false 对应 order 的 withRef（表单可编辑），
// readonly=true 对应 banking/hr-operations 的 ref（网格只读）。
func RefField(name, api, label string, reference *GridColumnRef, readonly bool) FieldMeta {
	return FieldMeta{Name: name, APIName: api, DBColumn: name, Type: TypeFK,
		Label: label, Filterable: true, Readonly: readonly, Ref: reference}
}

// CRUDActions 构造标准增删改查动作集（banking/hr-operations 的 crudActions）。
func CRUDActions() []ActionMeta {
	return []ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"},
		{Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"},
		{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
	}
}
