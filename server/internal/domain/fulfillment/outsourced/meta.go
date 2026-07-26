package outsourced

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	IssueResourceName            = "purOutsourcedIssues"
	IssueItemResourceName        = "purOutsourcedIssueItems"
	ReceiptResourceName          = "purOutsourcedReceipts"
	ReceiptItemResourceName      = "purOutsourcedReceiptItems"
	ReceiptMaterialResourceName  = "purOutsourcedReceiptItemMaterials"
	ReceiptByproductResourceName = "purOutsourcedReceiptItemByproducts"
	issuePermissionPrefix        = "purchase.outsourced_issue"
	receiptPermissionPrefix      = "purchase.outsourced_receipt"
	issuePermissionLabel         = "委外发料单"
	receiptPermissionLabel       = "委外入库单"
)

var partyTypeOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var documentStatusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "VOIDED", Label: "已作废"},
}

func IssueResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedIssue"
	return meta.ResourceMeta{
		Name:             IssueResourceName,
		PermissionPrefix: issuePermissionPrefix,
		PermissionLabel:  issuePermissionLabel,
		Table:            "pur_outsourced_issue",
		Fields: []meta.FieldMeta{
			idField(),
			field("issue_no", "issueNo", meta.TypeString, "发料单号"),
			field("issue_date", "issueDate", meta.TypeDate, "发料日期(库存分录业务日)"),
			enumField("party_type", "partyType", "对手类型(供应商/内部公司,须与所引委外订单一致)", partyTypeOptions),
			partyField(),
			field("remarks", "remarks", meta.TypeString, "备注(对内;可带入库存分录)"),
			enumField("status", "status", "状态", documentStatusOptions),
			field("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("from_warehouse_id", "fromWarehouseId", "默认调出仓(可空,仅新建行预填)", "invWarehouses", "fromWarehouse", "name"),
			refField("outsourced_warehouse_id", "outsourcedWarehouseId", "默认外协仓(可空,仅新建行预填)", "invWarehouses", "outsourcedWarehouse", "name"),
			refField("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
			refField("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "audit", Label: "审核", Scope: "row", Mutation: "auditPurOutsourcedIssue"},
			{Key: "void", Label: "作废", Scope: "row", Mutation: "voidPurOutsourcedIssue", IsDanger: true},
		},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func IssueItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedIssueItem"
	return meta.ResourceMeta{
		Name:             IssueItemResourceName,
		PermissionPrefix: issuePermissionPrefix,
		PermissionLabel:  issuePermissionLabel,
		Table:            "pur_outsourced_issue_item",
		Fields: []meta.FieldMeta{
			idField(),
			field("idx", "idx", meta.TypeInteger, "行号"),
			field("qty", "qty", meta.TypeDecimal, "录入数量"),
			field("base_qty", "baseQty", meta.TypeDecimal, "折算数量(材料默认单位,6 位)"),
			field("material_code", "materialCode", meta.TypeString, "物料编号"),
			field("material_name", "materialName", meta.TypeString, "物料名称"),
			field("material_spec", "materialSpec", meta.TypeString, "规格"),
			field("unit_name", "unitName", meta.TypeString, "单位名称"),
			field("order_no", "orderNo", meta.TypeString, "订单号"),
			field("remarks", "remarks", meta.TypeString, "行备注"),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refField("issue_id", "issueId", "委外发料单", IssueResourceName, "issue", "issueNo"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("order_item_material_id", "orderItemMaterialId", "发料清单行", "purOrderItemMaterials", "orderItemMaterial", "remarks"),
			refField("material_id", "materialId", "材料(以发料清单行为准)", "invMaterials", "material", "name"),
			refField("unit_id", "unitId", "单位(以发料清单行为准)", "basUnits", "unit", "name"),
			refField("from_warehouse_id", "fromWarehouseId", "调出仓(本公司启用叶子仓)", "invWarehouses", "fromWarehouse", "name"),
			refField("outsourced_warehouse_id", "outsourcedWarehouseId", "外协仓(限绑定当前对手)", "invWarehouses", "outsourcedWarehouse", "name"),
			field("issue_no", "issueNo", meta.TypeString, "发料单号"),
			field("issue_date", "issueDate", meta.TypeDate, "发料日期"),
			enumField("issue_status", "issueStatus", "发料单状态", documentStatusOptions),
			enumField("party_type", "partyType", "对手类型(供应商/内部公司)", partyTypeOptions),
			partyField(),
		},
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func ReceiptResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedReceipt"
	return meta.ResourceMeta{
		Name:             ReceiptResourceName,
		PermissionPrefix: receiptPermissionPrefix,
		PermissionLabel:  receiptPermissionLabel,
		Table:            "pur_outsourced_receipt",
		Fields: []meta.FieldMeta{
			idField(),
			field("receipt_no", "receiptNo", meta.TypeString, "入库单号"),
			field("receipt_date", "receiptDate", meta.TypeDate, "入库日期(库存分录业务日)"),
			field("posting_date", "postingDate", meta.TypeDate, "过账日期(总账;有金额审核时必填)"),
			enumField("party_type", "partyType", "对手类型(供应商/内部公司,须与所引委外订单一致)", partyTypeOptions),
			partyField(),
			field("remarks", "remarks", meta.TypeString, "备注(对内;可带入库存分录)"),
			enumField("status", "status", "状态", documentStatusOptions),
			field("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("warehouse_id", "warehouseId", "默认入仓(可空,成品行/副产物行新建与带出预填)", "invWarehouses", "warehouse", "name"),
			refField("outsourced_warehouse_id", "outsourcedWarehouseId", "默认外协仓(可空,材料扣减行带出预填;限绑定当前对手)", "invWarehouses", "outsourcedWarehouse", "name"),
			refField("debit_account_id", "debitAccountId", "借方科目(自选:存货/费用等;草稿必填)", "basAccounts", "debitAccount", "name"),
			refField("credit_account_id", "creditAccountId", "贷方科目(未开票应付;草稿必填)", "basAccounts", "creditAccount", "name"),
			refField("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
			refField("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "audit", Label: "审核", Scope: "row", Mutation: "auditPurOutsourcedReceipt"},
			{Key: "void", Label: "作废", Scope: "row", Mutation: "voidPurOutsourcedReceipt", IsDanger: true},
		},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func ReceiptItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedReceiptItem"
	return meta.ResourceMeta{
		Name:             ReceiptItemResourceName,
		PermissionPrefix: receiptPermissionPrefix,
		PermissionLabel:  receiptPermissionLabel,
		Table:            "pur_outsourced_receipt_item",
		Fields: []meta.FieldMeta{
			idField(),
			field("idx", "idx", meta.TypeInteger, "行号"),
			field("qty", "qty", meta.TypeDecimal, "录入数量"),
			field("base_qty", "baseQty", meta.TypeDecimal, "折算数量(物料默认单位,6 位)"),
			field("material_code", "materialCode", meta.TypeString, "物料编号"),
			field("material_name", "materialName", meta.TypeString, "物料名称"),
			field("material_spec", "materialSpec", meta.TypeString, "规格"),
			field("customer_part_no", "customerPartNo", meta.TypeString, "客户料号"),
			field("unit_name", "unitName", meta.TypeString, "单位名称"),
			field("order_no", "orderNo", meta.TypeString, "订单号"),
			field("order_qty", "orderQty", meta.TypeDecimal, "订购数量(订单行单位)"),
			field("order_base_qty", "orderBaseQty", meta.TypeDecimal, "订购数量(默认单位)"),
			field("order_unit_name", "orderUnitName", meta.TypeString, "订单行单位名称"),
			field("order_price", "orderPrice", meta.TypeDecimal, "原币含税单价(加工费)"),
			field("order_amount", "orderAmount", meta.TypeDecimal, "原币含税金额"),
			field("order_base_price", "orderBasePrice", meta.TypeDecimal, "本币含税单价(加工费)"),
			field("order_base_amount", "orderBaseAmount", meta.TypeDecimal, "本币含税金额"),
			field("order_tax_rate", "orderTaxRate", meta.TypeDecimal, "税率"),
			field("order_currency_code", "orderCurrencyCode", meta.TypeString, "订单原币代码"),
			field("reconciled_qty", "reconciledQty", meta.TypeDecimal, "已对账数量(默认单位;由采购对账单生效/回退同步)"),
			field("remarks", "remarks", meta.TypeString, "行备注"),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refField("receipt_id", "receiptId", "委外入库单", ReceiptResourceName, "receipt", "receiptNo"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("order_item_id", "orderItemId", "委外订单条目", "purOrderItems", "orderItem", "materialCode"),
			refField("material_id", "materialId", "物料(成品,须与订单条目一致)", "invMaterials", "material", "name"),
			refField("unit_id", "unitId", "单位", "basUnits", "unit", "name"),
			refField("warehouse_id", "warehouseId", "入库仓库", "invWarehouses", "warehouse", "name"),
			field("receipt_no", "receiptNo", meta.TypeString, "入库单号"),
			field("receipt_date", "receiptDate", meta.TypeDate, "入库日期"),
			enumField("receipt_status", "receiptStatus", "入库单状态", documentStatusOptions),
			enumField("party_type", "partyType", "对手类型(供应商/内部公司)", partyTypeOptions),
			partyField(),
			field("remaining_reconcilable_qty", "remainingReconcilableQty", meta.TypeDecimal, "剩余可对账量(默认单位)"),
		},
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func ReceiptMaterialResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedReceiptItemMaterial"
	return meta.ResourceMeta{
		Name:             ReceiptMaterialResourceName,
		PermissionPrefix: receiptPermissionPrefix,
		PermissionLabel:  receiptPermissionLabel,
		Table:            "pur_outsourced_receipt_item_material",
		Fields: append(
			receiptChildFields("扣减数量", "折算数量(材料默认单位,6 位)"),
			refField("receipt_item_id", "receiptItemId", "入库条目", ReceiptItemResourceName, "receiptItem", "materialCode"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("order_item_material_id", "orderItemMaterialId", "发料清单行", "purOrderItemMaterials", "orderItemMaterial", "remarks"),
			refField("material_id", "materialId", "材料(以发料清单行为准)", "invMaterials", "material", "name"),
			refField("unit_id", "unitId", "单位(以发料清单行为准)", "basUnits", "unit", "name"),
			refField("outsourced_warehouse_id", "outsourcedWarehouseId", "外协仓(可空,审核前必填;限绑定母单对手)", "invWarehouses", "outsourcedWarehouse", "name"),
			field("receipt_no", "receiptNo", meta.TypeString, "入库单号"),
		),
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func ReceiptByproductResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOutsourcedReceiptItemByproduct"
	return meta.ResourceMeta{
		Name:             ReceiptByproductResourceName,
		PermissionPrefix: receiptPermissionPrefix,
		PermissionLabel:  receiptPermissionLabel,
		Table:            "pur_outsourced_receipt_item_byproduct",
		Fields: append(
			receiptChildFields("入库数量", "折算数量(物料默认单位,6 位)"),
			refField("receipt_item_id", "receiptItemId", "入库条目", ReceiptItemResourceName, "receiptItem", "materialCode"),
			refField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refField("order_item_byproduct_id", "orderItemByproductId", "副产物清单行", "purOrderItemByproducts", "orderItemByproduct", "remarks"),
			refField("material_id", "materialId", "物料(以副产物清单行为准)", "invMaterials", "material", "name"),
			refField("unit_id", "unitId", "单位(以副产物清单行为准)", "basUnits", "unit", "name"),
			refField("warehouse_id", "warehouseId", "入仓(可空,审核前必填;本公司启用叶子仓)", "invWarehouses", "warehouse", "name"),
			field("receipt_no", "receiptNo", meta.TypeString, "入库单号"),
		),
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func receiptChildFields(quantityLabel, baseQuantityLabel string) []meta.FieldMeta {
	return []meta.FieldMeta{
		idField(),
		field("idx", "idx", meta.TypeInteger, "行号"),
		field("qty", "qty", meta.TypeDecimal, quantityLabel),
		field("base_qty", "baseQty", meta.TypeDecimal, baseQuantityLabel),
		field("material_code", "materialCode", meta.TypeString, "物料编号"),
		field("material_name", "materialName", meta.TypeString, "物料名称"),
		field("material_spec", "materialSpec", meta.TypeString, "规格"),
		field("unit_name", "unitName", meta.TypeString, "单位名称"),
		field("order_no", "orderNo", meta.TypeString, "订单号"),
		field("remarks", "remarks", meta.TypeString, "行备注"),
		field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
	}
}

func idField() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id",
		Readonly: true, Sortable: true,
	}
}

func field(name, apiName string, fieldType meta.FieldType, label string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: apiName, DBColumn: name, Type: fieldType, Label: label,
		Filterable: true, Sortable: true,
	}
}

func enumField(name, apiName, label string, options []meta.EnumOption) meta.FieldMeta {
	result := field(name, apiName, meta.TypeEnum, label)
	result.EnumOptions = options
	return result
}

func refField(name, apiName, label, resource, relation, labelField string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: apiName, DBColumn: name, Type: meta.TypeFK, Label: label,
		Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}

func partyField() meta.FieldMeta {
	discriminator, discriminatorType := "partyType", "enum"
	return meta.FieldMeta{
		Name: "party_id", APIName: "partyId", DBColumn: "party_id",
		Type: meta.TypeFK, Label: "对手", Filterable: true,
		Ref: &meta.GridColumnRef{
			Discriminator:     &discriminator,
			DiscriminatorType: &discriminatorType,
			Variants: []meta.GridColumnRefVariant{
				{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
				{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
			},
		},
	}
}
