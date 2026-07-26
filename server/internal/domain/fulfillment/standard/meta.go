package standard

import "github.com/z1coyan/synie/server/internal/platform/meta"

var fulfillmentPartyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var fulfillmentStatusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "VOIDED", Label: "已作废"},
}

// HeadResourceMeta 描述标准销售发货单或采购入库单的 GridMeta 契约。
func HeadResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	sales := spec.side == SideSales
	resource := "purReceipts"
	numberName, numberAPI, numberLabel := "receipt_no", "receiptNo", "入库单号"
	dateName, dateAPI, dateLabel := "receipt_date", "receiptDate", "入库日期(库存分录业务日)"
	partyLabel := "对手类型(供应商/内部公司)"
	debitLabel := "借方科目(自选:存货/费用等;草稿必填)"
	creditLabel := "贷方科目(未开票应付;草稿必填)"
	auditMutation, voidMutation, destroyMutation := "auditPurReceipt", "voidPurReceipt", "destroyPurReceipt"
	partyVariants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
	}
	if sales {
		resource = "salDeliveries"
		numberName, numberAPI, numberLabel = "delivery_no", "deliveryNo", "发货单号"
		dateName, dateAPI, dateLabel = "delivery_date", "deliveryDate", "发货日期(库存分录业务日)"
		partyLabel = "对手类型"
		debitLabel = "借方科目(未开票应收;草稿必填)"
		creditLabel = "贷方科目(草稿必填)"
		auditMutation, voidMutation, destroyMutation = "auditSalDelivery", "voidSalDelivery", "destroySalDelivery"
		partyVariants = []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
		}
	}

	discriminator, discriminatorType := "partyType", "enum"
	fields := []meta.FieldMeta{
		metaIDField(),
		metaScalar(numberName, numberAPI, meta.TypeString, numberLabel),
		metaScalar(dateName, dateAPI, meta.TypeDate, dateLabel),
		metaScalar("posting_date", "postingDate", meta.TypeDate, "过账日期(总账;有金额审核时必填)"),
		metaEnum("party_type", "partyType", partyLabel, fulfillmentPartyOptions),
		{
			Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK,
			Label: "对手", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{
				Discriminator:     &discriminator,
				DiscriminatorType: &discriminatorType,
				Variants:          partyVariants,
			},
		},
		metaScalar("remarks", "remarks", meta.TypeString, "备注(对内;可带入库存分录)"),
		metaEnum("status", "status", "状态", fulfillmentStatusOptions),
		metaScalar("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
		metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
		metaRefField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
		metaRefField("warehouse_id", "warehouseId", "默认仓库(可空,仅新建行预填)", "invWarehouses", "warehouse", "name"),
		metaRefField("debit_account_id", "debitAccountId", debitLabel, "basAccounts", "debitAccount", "name"),
		metaRefField("credit_account_id", "creditAccountId", creditLabel, "basAccounts", "creditAccount", "name"),
		metaRefField("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
		metaRefField("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
	}
	actions := []meta.ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"},
		{Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"},
		{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		{Key: "audit", Label: "审核", Scope: "row", Mutation: auditMutation},
		{Key: "void", Label: "作废", Scope: "row", Mutation: voidMutation, IsDanger: true},
	}
	if sales {
		actions = append(actions,
			meta.ActionMeta{Key: "print", Label: "打印", Scope: "row"},
			meta.ActionMeta{Key: "export", Label: "导出", Scope: "both"},
			meta.ActionMeta{Key: "batch_print", Label: "批量打印", Scope: "batch"},
		)
	}

	return meta.ResourceMeta{
		Name:             resource,
		PermissionPrefix: spec.prefix,
		PermissionLabel:  spec.label,
		Table:            spec.headTable,
		Fields:           fields,
		Actions:          actions,
		Print:            sales,
		Audit:            meta.AuditMeta{Enabled: true},
		DestroyMutation:  &destroyMutation,
	}
}

// ItemResourceMeta 描述标准销售发货行或采购入库行的 GridMeta 契约。
func ItemResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	sales := spec.side == SideSales
	resource := "purReceiptItems"
	parentName, parentAPI, parentLabel := "receipt_id", "receiptId", "采购入库单"
	parentResource, parentRelation, parentLabelField := "purReceipts", "receipt", "receiptNo"
	orderItemResource := "purOrderItems"
	warehouseLabel := "入库仓库"
	numberName, numberAPI, numberLabel := "receipt_no", "receiptNo", "入库单号"
	dateName, dateAPI, dateLabel := "receipt_date", "receiptDate", "入库日期"
	statusName, statusAPI, statusLabel := "receipt_status", "receiptStatus", "入库单状态"
	partyLabel := "对手类型(供应商/内部公司)"
	reconciledLabel := "已对账数量(默认单位;由采购对账单生效/回退同步)"
	destroyMutation := "destroyPurReceiptItem"
	partyVariants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
	}
	if sales {
		resource = "salDeliveryItems"
		parentName, parentAPI, parentLabel = "delivery_id", "deliveryId", "销售发货单"
		parentResource, parentRelation, parentLabelField = "salDeliveries", "delivery", "deliveryNo"
		orderItemResource = "salOrderItems"
		warehouseLabel = "出库仓库"
		numberName, numberAPI, numberLabel = "delivery_no", "deliveryNo", "发货单号"
		dateName, dateAPI, dateLabel = "delivery_date", "deliveryDate", "发货日期"
		statusName, statusAPI, statusLabel = "delivery_status", "deliveryStatus", "发货单状态"
		partyLabel = "对手类型"
		reconciledLabel = "已对账数量(默认单位;由销售对账单生效/回退同步)"
		destroyMutation = "destroySalDeliveryItem"
		partyVariants = []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
		}
	}

	fields := []meta.FieldMeta{
		metaIDField(),
		metaScalar("idx", "idx", meta.TypeInteger, "行号"),
		metaScalar("qty", "qty", meta.TypeDecimal, "录入数量"),
		metaScalar("base_qty", "baseQty", meta.TypeDecimal, "折算数量(物料默认单位,6 位)"),
		metaScalar("material_code", "materialCode", meta.TypeString, "物料编号"),
		metaScalar("material_name", "materialName", meta.TypeString, "物料名称"),
		metaScalar("material_spec", "materialSpec", meta.TypeString, "规格"),
		metaScalar("customer_part_no", "customerPartNo", meta.TypeString, "客户料号"),
		metaScalar("unit_name", "unitName", meta.TypeString, "单位名称"),
		metaScalar("order_no", "orderNo", meta.TypeString, "订单号"),
		metaScalar("order_qty", "orderQty", meta.TypeDecimal, "订购数量(订单行单位)"),
		metaScalar("order_base_qty", "orderBaseQty", meta.TypeDecimal, "订购数量(默认单位)"),
		metaScalar("order_unit_name", "orderUnitName", meta.TypeString, "订单行单位名称"),
		metaScalar("order_price", "orderPrice", meta.TypeDecimal, "原币含税单价"),
		metaScalar("order_amount", "orderAmount", meta.TypeDecimal, "原币含税金额"),
		metaScalar("order_base_price", "orderBasePrice", meta.TypeDecimal, "本币含税单价"),
		metaScalar("order_base_amount", "orderBaseAmount", meta.TypeDecimal, "本币含税金额"),
		metaScalar("order_tax_rate", "orderTaxRate", meta.TypeDecimal, "税率"),
		metaScalar("order_currency_code", "orderCurrencyCode", meta.TypeString, "订单原币代码"),
		metaScalar("reconciled_qty", "reconciledQty", meta.TypeDecimal, reconciledLabel),
		metaScalar("remarks", "remarks", meta.TypeString, "行备注"),
		metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
		metaRefField(parentName, parentAPI, parentLabel, parentResource, parentRelation, parentLabelField),
		metaRefField("company_id", "companyId", "公司", "basCompanies", "company", "name"),
		metaRefField("order_item_id", "orderItemId", "订单条目", orderItemResource, "orderItem", "materialCode"),
		metaRefField("material_id", "materialId", "物料", "invMaterials", "material", "name"),
		metaRefField("unit_id", "unitId", "单位", "basUnits", "unit", "name"),
		metaRefField("warehouse_id", "warehouseId", warehouseLabel, "invWarehouses", "warehouse", "name"),
		metaScalar(numberName, numberAPI, meta.TypeString, numberLabel),
		metaScalar(dateName, dateAPI, meta.TypeDate, dateLabel),
		metaEnum(statusName, statusAPI, statusLabel, fulfillmentStatusOptions),
		metaEnum("party_type", "partyType", partyLabel, fulfillmentPartyOptions),
	}
	discriminator, discriminatorType := "partyType", "enum"
	fields = append(fields,
		meta.FieldMeta{
			Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK,
			Label: "对手", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{
				Discriminator:     &discriminator,
				DiscriminatorType: &discriminatorType,
				Variants:          partyVariants,
			},
		},
		metaScalar("remaining_reconcilable_qty", "remainingReconcilableQty", meta.TypeDecimal, "剩余可对账量(默认单位)"),
	)

	return meta.ResourceMeta{
		Name:             resource,
		PermissionPrefix: spec.prefix,
		PermissionLabel:  spec.label,
		Table:            spec.itemTable,
		Fields:           fields,
		Actions:          []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:            meta.AuditMeta{Enabled: true},
		DestroyMutation:  &destroyMutation,
	}
}

// itemQueryResourceMeta extends only the service query seam. The legacy GridMeta
// contract did not publish the source order type, but reconciliation candidate
// queries must still exclude sample-order deliveries without reintroducing a
// nested GraphQL filter.
func itemQueryResourceMeta(side Side) meta.ResourceMeta {
	resource := ItemResourceMeta(side)
	if side != SideSales {
		return resource
	}
	resource.Fields = append(append([]meta.FieldMeta(nil), resource.Fields...), meta.FieldMeta{
		Name:       "order_type",
		APIName:    "orderType",
		DBColumn:   "order_type",
		Type:       meta.TypeEnum,
		Label:      "来源订单类型",
		Filterable: true,
		EnumOptions: []meta.EnumOption{
			{Value: "REGULAR", Label: "常规"},
			{Value: "SAMPLE", Label: "样品"},
		},
	})
	return resource
}

func metaIDField() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID,
		Label: "id", Sortable: true, Readonly: true,
	}
}

func metaScalar(name, apiName string, fieldType meta.FieldType, label string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: apiName, DBColumn: name, Type: fieldType,
		Label: label, Sortable: true, Filterable: true,
	}
}

func metaEnum(name, apiName, label string, options []meta.EnumOption) meta.FieldMeta {
	field := metaScalar(name, apiName, meta.TypeEnum, label)
	field.EnumOptions = options
	return field
}

func metaRefField(name, apiName, label, resource, relation, labelField string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: apiName, DBColumn: name, Type: meta.TypeFK,
		Label: label, Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}
