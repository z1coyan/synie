package stockcount

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	ResourceName     = "invStockCounts"
	ItemResourceName = "invStockCountItems"
)

var statusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "CANCELLED", Label: "已作废"},
}

var auditedFields = []string{
	"doc_no", "posting_date", "summary", "remarks", "status", "audited_at",
	"snapshot_taken_at", "company_id", "warehouse_id", "created_by_id", "audited_by_id",
}

var itemAuditedFields = []string{
	"counted_quantity", "converted_counted", "book_quantity", "material_code",
	"material_name", "material_spec", "unit_name", "remark", "count_id",
	"company_id", "material_id", "unit_id",
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvStockCount"
	companyResource, companyRelation := "basCompanies", "company"
	warehouseResource, warehouseRelation := "invWarehouses", "warehouse"
	userResource, createdRelation, auditedRelation := "sysUsers", "createdBy", "auditedBy"
	nameField := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.stock_count",
		PermissionLabel: "库存盘点单", Table: "inv_stock_count",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "doc_no", APIName: "docNo", DBColumn: "doc_no", Type: meta.TypeString, Label: "单据编号", Required: true, Filterable: true, Sortable: true},
			{Name: "posting_date", APIName: "postingDate", DBColumn: "posting_date", Type: meta.TypeDate, Label: "业务日期", Required: true, Filterable: true, Sortable: true},
			{Name: "summary", APIName: "summary", DBColumn: "summary", Type: meta.TypeString, Label: "摘要(带入库存分录)", Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "备注(对内)", Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true},
			{Name: "audited_at", APIName: "auditedAt", DBColumn: "audited_at", Type: meta.TypeDatetime, Label: "审核时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "snapshot_taken_at", APIName: "snapshotTakenAt", DBColumn: "snapshot_taken_at", Type: meta.TypeDatetime, Label: "账面快照时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "warehouse_id", APIName: "warehouseId", DBColumn: "warehouse_id", Type: meta.TypeFK, Label: "仓库(限本公司叶子仓)", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &warehouseRelation, LabelField: &nameField}},
			{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "录入人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &userResource, Relation: &createdRelation, LabelField: &nameField}},
			{Name: "audited_by_id", APIName: "auditedById", DBColumn: "audited_by_id", Type: meta.TypeFK, Label: "审核人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &userResource, Relation: &auditedRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "approve", Label: "审核", Scope: "row", Mutation: "approveInvStockCount"},
			{Key: "cancel", Label: "作废", Scope: "row", Mutation: "cancelInvStockCount", IsDanger: true},
		},
		Print:      true,
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: ItemResourceName}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvStockCountItem"
	countResource, countRelation := ResourceName, "count"
	companyResource, companyRelation := "basCompanies", "company"
	materialResource, materialRelation := "invMaterials", "material"
	unitResource, unitRelation := "basUnits", "unit"
	nameField, docNoField := "name", "docNo"
	return meta.ResourceMeta{
		Name: ItemResourceName, PermissionPrefix: "inv.stock_count",
		PermissionLabel: "库存盘点单", Table: "inv_stock_count_item",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "counted_quantity", APIName: "countedQuantity", DBColumn: "counted_quantity", Type: meta.TypeDecimal, Label: "实盘数量(录入单位口径,审核前可空)", Filterable: true, Sortable: true},
			{Name: "converted_counted", APIName: "convertedCounted", DBColumn: "converted_counted", Type: meta.TypeDecimal, Label: "折算实盘(系统算:物料默认单位口径,6 位小数)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "book_quantity", APIName: "bookQuantity", DBColumn: "book_quantity", Type: meta.TypeDecimal, Label: "账面数量快照(系统取数:物料默认单位口径,6 位小数)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_code", APIName: "materialCode", DBColumn: "material_code", Type: meta.TypeString, Label: "物料编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_name", APIName: "materialName", DBColumn: "material_name", Type: meta.TypeString, Label: "物料名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_spec", APIName: "materialSpec", DBColumn: "material_spec", Type: meta.TypeString, Label: "规格", Readonly: true, Filterable: true, Sortable: true},
			{Name: "unit_name", APIName: "unitName", DBColumn: "unit_name", Type: meta.TypeString, Label: "单位名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remark", APIName: "remark", DBColumn: "remark", Type: meta.TypeString, Label: "行备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "count_id", APIName: "countId", DBColumn: "count_id", Type: meta.TypeFK, Label: "库存盘点单", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &countResource, Relation: &countRelation, LabelField: &docNoField}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &materialResource, Relation: &materialRelation, LabelField: &nameField}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "单位", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Print:   true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
