package reconciliation

import "github.com/z1coyan/synie/server/internal/platform/meta"

var partyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var kindOptions = []meta.EnumOption{
	{Value: "REGULAR", Label: "常规"},
	{Value: "GIFT_SAMPLE", Label: "赠送/样品"},
}

func HeadResourceMeta(side Side) meta.ResourceMeta {
	spec, err := specFor(side)
	if err != nil {
		panic(err)
	}
	sales := side == SideSales
	resource, confirmedLabel := "purReconciliations", "供应商已确认"
	partyLabel := "对手类型(供应商/内部公司)"
	debitLabel := "借方科目(未开票应付;草稿必填)"
	creditLabel := "贷方科目(常规单=入库借方口径;赠送/样品单=收益类;草稿必填)"
	confirmMutation, unconfirmMutation := "confirmPurReconciliation", "unconfirmPurReconciliation"
	auditMutation, voidMutation := "auditPurReconciliation", "voidPurReconciliation"
	destroyMutation := "destroyPurReconciliation"
	partyVariants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
	}
	if sales {
		resource, confirmedLabel = "salReconciliations", "客户已确认"
		partyLabel = "对手类型"
		debitLabel = "借方科目(常规单=发货贷方口径;赠送/样品单=费用损失类;草稿必填)"
		creditLabel = "贷方科目(未开票应收;草稿必填)"
		confirmMutation, unconfirmMutation = "confirmSalReconciliation", "unconfirmSalReconciliation"
		auditMutation, voidMutation = "auditSalReconciliation", "voidSalReconciliation"
		destroyMutation = "destroySalReconciliation"
		partyVariants = []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
		}
	}
	statusOptions := []meta.EnumOption{
		{Value: "DRAFT", Label: "草稿"},
		{Value: "CONFIRMED", Label: confirmedLabel},
		{Value: "CLOSED", Label: "已结单"},
		{Value: "VOIDED", Label: "已作废"},
	}
	discriminator, discriminatorType := "partyType", "enum"
	fields := []meta.FieldMeta{
		metaID(),
		metaScalar("reconciliation_no", "reconciliationNo", meta.TypeString, "对账单号"),
		metaEnum("reconciliation_type", "reconciliationType",
			"对账类型(常规/赠送样品;保存后锁死)", kindOptions),
		metaEnum("party_type", "partyType", partyLabel, partyOptions),
		{
			Name: "party_id", APIName: "partyId", DBColumn: "party_id",
			Type: meta.TypeFK, Label: "对手", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{
				Discriminator: &discriminator, DiscriminatorType: &discriminatorType,
				Variants: partyVariants,
			},
		},
		metaScalar("posting_date", "postingDate", meta.TypeDate,
			"过账日期(赠送/样品单结单总账;有金额结单时必填,默认结单当日)"),
		metaScalar("remarks", "remarks", meta.TypeString, "备注"),
		metaEnum("status", "status", "状态", statusOptions),
		metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
		metaRef("company_id", "companyId", "公司", "basCompanies", "company", "name"),
		metaRef("debit_account_id", "debitAccountId", debitLabel,
			"basAccounts", "debitAccount", "name"),
		metaRef("credit_account_id", "creditAccountId", creditLabel,
			"basAccounts", "creditAccount", "name"),
		metaRef("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
		metaCalculated(metaReadonly("gross_total", "grossTotal", meta.TypeDecimal,
			"原币含税合计(行原币金额合计;单内同币种)", false, false)),
		metaCalculated(metaReadonly("base_gross_total", "baseGrossTotal", meta.TypeDecimal,
			"本币含税合计(行本币金额合计;发票价税合计须与之相等)", false, false)),
	}
	itemResource := "purReconciliationItems"
	if sales {
		itemResource = "salReconciliationItems"
	}
	return meta.ResourceMeta{
		Name: resource, PermissionPrefix: spec.prefix, PermissionLabel: spec.label,
		Table: spec.table, Fields: fields,
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: itemResource}},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "confirm", Label: confirmedLabel[:len(confirmedLabel)-len("已确认")] + "确认",
				Scope: "row", Mutation: confirmMutation},
			{Key: "unconfirm", Label: "撤回确认", Scope: "row",
				Mutation: unconfirmMutation, IsDanger: true},
			{Key: "audit", Label: "结单", Scope: "row", Mutation: auditMutation},
			{Key: "void", Label: "作废", Scope: "row", Mutation: voidMutation, IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroyMutation,
	}
}

func ItemResourceMeta(side Side) meta.ResourceMeta {
	spec, err := specFor(side)
	if err != nil {
		panic(err)
	}
	sales := side == SideSales
	resource, parentResource := "purReconciliationItems", "purReconciliations"
	parentLabel, confirmedLabel := "采购对账单", "供应商已确认"
	destroyMutation := "destroyPurReconciliationItem"
	sourceFields := []meta.FieldMeta{
		metaRef("receipt_item_id", "receiptItemId",
			"入库条目(采购入库;与委外入库条目恰挂其一)",
			"purReceiptItems", "receiptItem", "materialCode"),
		metaRef("outsourced_receipt_item_id", "outsourcedReceiptItemId",
			"委外入库条目(与采购入库条目恰挂其一)",
			"purOutsourcedReceiptItems", "outsourcedReceiptItem", "materialCode"),
	}
	sourceNoName, sourceNoAPI, sourceNoLabel := "receipt_no", "receiptNo", "入库单号"
	sourceDateName, sourceDateAPI, sourceDateLabel := "receipt_date", "receiptDate", "入库日期"
	materialLabel, unitLabel := "物料名称(入库条目快照)", "单位名称(入库条目快照)"
	qtyLabel := "对账数量(入库条目行单位)"
	if sales {
		resource, parentResource = "salReconciliationItems", "salReconciliations"
		parentLabel, confirmedLabel = "销售对账单", "客户已确认"
		destroyMutation = "destroySalReconciliationItem"
		sourceFields = []meta.FieldMeta{
			metaRef("delivery_item_id", "deliveryItemId", "发货条目",
				"salDeliveryItems", "deliveryItem", "materialCode"),
		}
		sourceNoName, sourceNoAPI, sourceNoLabel = "delivery_no", "deliveryNo", "发货单号"
		sourceDateName, sourceDateAPI, sourceDateLabel = "delivery_date", "deliveryDate", "发货日期"
		materialLabel, unitLabel = "物料名称(发货条目快照)", "单位名称(发货条目快照)"
		qtyLabel = "对账数量(发货条目行单位)"
	}
	statusOptions := []meta.EnumOption{
		{Value: "DRAFT", Label: "草稿"},
		{Value: "CONFIRMED", Label: confirmedLabel},
		{Value: "CLOSED", Label: "已结单"},
		{Value: "VOIDED", Label: "已作废"},
	}
	fields := []meta.FieldMeta{
		metaID(),
		metaScalar("idx", "idx", meta.TypeInteger, "行号"),
		metaScalar("qty", "qty", meta.TypeDecimal, qtyLabel),
		metaScalar("base_qty", "baseQty", meta.TypeDecimal,
			"折算数量(物料默认单位,6 位;与已对账数量同口径)"),
		metaScalar("amount", "amount", meta.TypeDecimal,
			"原币含税金额(数量×快照原币含税单价,2 位)"),
		metaScalar("base_amount", "baseAmount", meta.TypeDecimal,
			"本币含税金额(原币金额×源订单汇率,2 位)"),
		metaScalar("remarks", "remarks", meta.TypeString, "行备注"),
		metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
		metaRef("reconciliation_id", "reconciliationId", parentLabel,
			parentResource, "reconciliation", "reconciliationNo"),
		metaRef("company_id", "companyId", "公司", "basCompanies", "company", "name"),
	}
	fields = append(fields, sourceFields...)
	fields = append(fields,
		metaScalar("reconciliation_no", "reconciliationNo", meta.TypeString, "对账单号"),
		metaEnum("reconciliation_status", "reconciliationStatus", "对账单状态", statusOptions),
		metaScalar(sourceNoName, sourceNoAPI, meta.TypeString, sourceNoLabel),
		metaScalar(sourceDateName, sourceDateAPI, meta.TypeDate, sourceDateLabel),
		metaScalar("material_name", "materialName", meta.TypeString, materialLabel),
		metaScalar("unit_name", "unitName", meta.TypeString, unitLabel),
		metaScalar("order_currency_code", "orderCurrencyCode", meta.TypeString, "订单原币代码"),
	)
	return meta.ResourceMeta{
		Name: resource, PermissionPrefix: spec.prefix, PermissionLabel: spec.label,
		Table: spec.itemTable, Fields: fields,
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroyMutation,
	}
}

func metaID() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID,
		Label: "id", Sortable: true, Readonly: true,
	}
}

func metaScalar(name, api string, kind meta.FieldType, label string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: kind, Label: label,
		Filterable: true, Sortable: true,
	}
}

func metaReadonly(
	name, api string, kind meta.FieldType, label string, filterable, sortable bool,
) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: kind, Label: label,
		Readonly: true, Filterable: filterable, Sortable: sortable,
	}
}

func metaEnum(name, api, label string, values []meta.EnumOption) meta.FieldMeta {
	field := metaScalar(name, api, meta.TypeEnum, label)
	field.EnumOptions = values
	return field
}

// metaCalculated 标记计算/投影字段：打印字段目录做一层关联展开时跳过。
func metaCalculated(field meta.FieldMeta) meta.FieldMeta {
	field.Calculated = true
	return field
}

func metaRef(
	name, api, label, resource, relation, labelField string,
) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: meta.TypeFK,
		Label: label, Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}
