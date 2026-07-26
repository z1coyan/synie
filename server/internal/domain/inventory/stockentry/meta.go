package stockentry

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "invStockEntries"

func ResourceMeta() meta.ResourceMeta {
	companyResource, companyRelation := "basCompanies", "company"
	warehouseResource, warehouseRelation := "invWarehouses", "warehouse"
	materialResource, materialRelation := "invMaterials", "material"
	nameField := "name"
	discriminator, discriminatorType := "voucherType", "string"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "inv.stock_entry",
		PermissionLabel: "库存分录", Table: "inv_stock_entry",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "seq", APIName: "seq", DBColumn: "seq", Type: meta.TypeInteger, Label: "序号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "quantity", APIName: "quantity", DBColumn: "quantity", Type: meta.TypeDecimal, Label: "数量(带符号,入正出负,物料默认单位口径)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "posting_date", APIName: "postingDate", DBColumn: "posting_date", Type: meta.TypeDate, Label: "业务日期", Readonly: true, Filterable: true, Sortable: true},
			{Name: "voucher_type", APIName: "voucherType", DBColumn: "voucher_type", Type: meta.TypeString, Label: "来源单据类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "voucher_id", APIName: "voucherId", DBColumn: "voucher_id", Type: meta.TypeFK, Label: "来源单据", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{
					Discriminator: &discriminator, DiscriminatorType: &discriminatorType,
					Variants: []meta.GridColumnRefVariant{
						{Value: "inv.stock_count", Resource: "invStockCounts", LabelField: "docNo", Label: "库存盘点单"},
						{Value: "inv.stock_doc", Resource: "invStockDocs", LabelField: "docNo", Label: "手工出入库单"},
						{Value: "inv.stock_transfer", Resource: "invStockTransfers", LabelField: "docNo", Label: "手工调拨单"},
						{Value: "mfg.output", Resource: "mfgOutputs", LabelField: "outputNo", Label: "生产入库单"},
						{Value: "purchase.outsourced_issue", Resource: "purOutsourcedIssues", LabelField: "issueNo", Label: "委外发料单"},
						{Value: "purchase.outsourced_receipt", Resource: "purOutsourcedReceipts", LabelField: "receiptNo", Label: "委外入库单"},
						{Value: "purchase.receipt", Resource: "purReceipts", LabelField: "receiptNo", Label: "采购入库单"},
						{Value: "sales.delivery", Resource: "salDeliveries", LabelField: "deliveryNo", Label: "销售发货单"},
					},
				}},
			{Name: "voucher_no", APIName: "voucherNo", DBColumn: "voucher_no", Type: meta.TypeString, Label: "来源单据编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "is_cancelled", APIName: "isCancelled", DBColumn: "is_cancelled", Type: meta.TypeBoolean, Label: "已作废", Readonly: true, Filterable: true, Sortable: true},
			{Name: "cancelled_at", APIName: "cancelledAt", DBColumn: "cancelled_at", Type: meta.TypeDatetime, Label: "作废时间(盘点单审核的兜底校验据此判定「快照后该仓分录有作废」)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "摘要", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "warehouse_id", APIName: "warehouseId", DBColumn: "warehouse_id", Type: meta.TypeFK, Label: "仓库", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &warehouseResource, Relation: &warehouseRelation, LabelField: &nameField}},
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &materialResource, Relation: &materialRelation, LabelField: &nameField}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: false},
	}
}
