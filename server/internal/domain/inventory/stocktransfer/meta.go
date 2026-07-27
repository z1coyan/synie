package stocktransfer

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	ResourceName     = "invStockTransfers"
	ItemResourceName = "invStockTransferItems"
)

var statusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "SHIPPED", Label: "已发货"},
	{Value: "RECEIVED", Label: "已收货"},
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvStockTransfer"
	companyResource, companyRelation := "basCompanies", "company"
	warehouseResource := "invWarehouses"
	fromRelation, toRelation, transitRelation := "fromWarehouse", "toWarehouse", "transitWarehouse"
	userResource, createdRelation := "sysUsers", "createdBy"
	shippedRelation, receivedRelation := "shippedBy", "receivedBy"
	nameField := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.stock_transfer",
		PermissionLabel: "手工调拨单", Table: "inv_stock_transfer",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "doc_no", APIName: "docNo", DBColumn: "doc_no", Type: meta.TypeString, Label: "单据编号", Required: true, Filterable: true, Sortable: true},
			{Name: "doc_date", APIName: "docDate", DBColumn: "doc_date", Type: meta.TypeDate, Label: "业务日期", Required: true, Filterable: true, Sortable: true},
			{Name: "summary", APIName: "summary", DBColumn: "summary", Type: meta.TypeString, Label: "摘要(带入库存分录)", Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "备注(对内)", Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true},
			{Name: "shipped_at", APIName: "shippedAt", DBColumn: "shipped_at", Type: meta.TypeDatetime, Label: "发货时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "received_at", APIName: "receivedAt", DBColumn: "received_at", Type: meta.TypeDatetime, Label: "收货时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "from_warehouse_id", APIName: "fromWarehouseId", DBColumn: "from_warehouse_id", Type: meta.TypeFK, Label: "调出仓库(限本公司叶子仓)", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &fromRelation, LabelField: &nameField}},
			{Name: "to_warehouse_id", APIName: "toWarehouseId", DBColumn: "to_warehouse_id", Type: meta.TypeFK, Label: "调入仓库(限本公司叶子仓)", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &toRelation, LabelField: &nameField}},
			{Name: "transit_warehouse_id", APIName: "transitWarehouseId", DBColumn: "transit_warehouse_id", Type: meta.TypeFK, Label: "在途仓库(限本公司叶子仓)", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &transitRelation, LabelField: &nameField}},
			{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "录入人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &userResource, Relation: &createdRelation, LabelField: &nameField}},
			{Name: "shipped_by_id", APIName: "shippedById", DBColumn: "shipped_by_id", Type: meta.TypeFK, Label: "发货人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &userResource, Relation: &shippedRelation, LabelField: &nameField}},
			{Name: "received_by_id", APIName: "receivedById", DBColumn: "received_by_id", Type: meta.TypeFK, Label: "收货人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &userResource, Relation: &receivedRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "ship", Label: "发货", Scope: "row", Mutation: "shipInvStockTransfer"},
			{Key: "receive", Label: "收货", Scope: "row", Mutation: "receiveInvStockTransfer"},
		},
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "status", "shippedAt", "receivedAt", "insertedAt", "updatedAt", "createdById", "shippedById", "receivedById"},
			Fields: map[string]map[string]any{
				"docNo": {"placeholder": "留空自动编号"}, "docDate": {"required": true},
				"companyId":       {"required": true, "edit": "createOnly"},
				"fromWarehouseId": {"required": true}, "toWarehouseId": {"required": true},
				"transitWarehouseId": {"required": true},
			},
		},
		Print:      true,
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: ItemResourceName}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyInvStockTransferItem"
	docResource, docRelation := ResourceName, "stockTransfer"
	companyResource, companyRelation := "basCompanies", "company"
	materialResource, materialRelation := "invMaterials", "material"
	unitResource, unitRelation := "basUnits", "unit"
	nameField, docNoField := "name", "docNo"
	return meta.ResourceMeta{
		Name: ItemResourceName, PermissionPrefix: "inv.stock_transfer",
		PermissionLabel: "手工调拨单", Table: "inv_stock_transfer_item",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "idx", APIName: "idx", DBColumn: "idx", Type: meta.TypeInteger, Label: "行号", Required: true, Filterable: true, Sortable: true},
			{Name: "qty", APIName: "qty", DBColumn: "qty", Type: meta.TypeDecimal, Label: "录入数量", Required: true, Filterable: true, Sortable: true},
			{Name: "base_qty", APIName: "baseQty", DBColumn: "base_qty", Type: meta.TypeDecimal, Label: "折算数量(系统算:物料默认单位口径,6 位小数)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "received_qty", APIName: "receivedQty", DBColumn: "received_qty", Type: meta.TypeDecimal, Label: "实收数量(收货回写,折算口径)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_code", APIName: "materialCode", DBColumn: "material_code", Type: meta.TypeString, Label: "物料编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_name", APIName: "materialName", DBColumn: "material_name", Type: meta.TypeString, Label: "物料名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_spec", APIName: "materialSpec", DBColumn: "material_spec", Type: meta.TypeString, Label: "规格", Readonly: true, Filterable: true, Sortable: true},
			{Name: "unit_name", APIName: "unitName", DBColumn: "unit_name", Type: meta.TypeString, Label: "单位名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remark", APIName: "remark", DBColumn: "remark", Type: meta.TypeString, Label: "行备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "stock_transfer_id", APIName: "stockTransferId", DBColumn: "stock_transfer_id", Type: meta.TypeFK, Label: "调拨单", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &docResource, Relation: &docRelation, LabelField: &docNoField}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &materialResource, Relation: &materialRelation, LabelField: &nameField}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "单位", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Form: &meta.FormMetaDTO{Exclude: []string{
			"id", "baseQty", "receivedQty", "materialCode", "materialName", "materialSpec",
			"unitName", "companyId", "insertedAt", "updatedAt",
		}},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
