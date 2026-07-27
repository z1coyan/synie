package order

import "github.com/z1coyan/synie/server/internal/platform/meta"

var orderPartyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var orderStatusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"}, {Value: "AUDITED", Label: "已审核"},
	{Value: "CLOSED", Label: "已关闭"}, {Value: "VOIDED", Label: "已作废"},
}

func OrderResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	orderTypes := []meta.EnumOption{{Value: "REGULAR", Label: "常规订单"}}
	partyLabel, termsLabel := "对手类型(客户/内部公司)", "交易条款(对客户,自由文本)"
	variants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
	}
	if side == SideSales {
		orderTypes = append(orderTypes, meta.EnumOption{Value: "SAMPLE", Label: "样品订单"})
	} else {
		orderTypes = append(orderTypes, meta.EnumOption{Value: "SPOT", Label: "零星订单"})
		partyLabel, termsLabel = "对手类型(供应商/内部公司)", "交易条款(对供应商,自由文本)"
		variants = []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
		}
	}
	fields := []meta.FieldMeta{
		meta.Field("id", "id", meta.TypeUUID, "id", true, false, true),
		meta.Field("order_no", "orderNo", meta.TypeString, "订单号", true, true, true),
		meta.EnumField("order_date", "orderDate", meta.TypeDate, "订单日期", nil, false),
		meta.EnumField("order_type", "orderType", meta.TypeEnum, "订单类型", orderTypes, false),
	}
	if side == SidePurchase {
		fields = append(fields, meta.EnumField("is_outsourced", "isOutsourced", meta.TypeBoolean, "委外标记", nil, false))
	}
	discriminator, discriminatorType := "partyType", "enum"
	company, currency, user, name := "basCompanies", "basCurrencies", "sysUsers", "name"
	companyRel, currencyRel, createdRel, auditedRel := "company", "currency", "createdBy", "auditedBy"
	fields = append(fields,
		meta.EnumField("party_type", "partyType", meta.TypeEnum, partyLabel, orderPartyOptions, false),
		meta.FieldMeta{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
		meta.EnumField("exchange_rate", "exchangeRate", meta.TypeDecimal, "汇率(原币→本币)", nil, false),
		meta.EnumField("terms", "terms", meta.TypeString, termsLabel, nil, false),
		meta.EnumField("remarks", "remarks", meta.TypeString, "订单备注(对内)", nil, false),
		meta.EnumField("status", "status", meta.TypeEnum, "状态", orderStatusOptions, false),
		meta.EnumField("audited_at", "auditedAt", meta.TypeDatetime, "审核时间", nil, false),
		meta.EnumField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil, false),
		meta.EnumField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil, false),
		meta.FieldMeta{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
		meta.FieldMeta{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种(原币)", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &currency, Relation: &currencyRel, LabelField: &name}},
		meta.FieldMeta{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "录入人", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &user, Relation: &createdRel, LabelField: &name}},
		meta.FieldMeta{Name: "audited_by_id", APIName: "auditedById", DBColumn: "audited_by_id", Type: meta.TypeFK, Label: "审核人", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &user, Relation: &auditedRel, LabelField: &name}},
		meta.Field("gross_total", "grossTotal", meta.TypeDecimal, "原币含税总额(行原币含税金额合计)", false, false, false),
		meta.Field("base_gross_total", "baseGrossTotal", meta.TypeDecimal, "本币含税总额(行本币含税金额合计)", false, false, false),
	)
	actions := []meta.ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"}, {Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"}, {Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		{Key: "audit", Label: "审核", Scope: "row", Mutation: spec.auditMutation},
		{Key: "close", Label: "关闭", Scope: "row", Mutation: spec.closeMutation},
		{Key: "void", Label: "作废", Scope: "row", Mutation: spec.voidMutation, IsDanger: true},
	}
	if side == SideSales {
		actions = append(actions,
			meta.ActionMeta{Key: "print", Label: "打印", Scope: "row"},
			meta.ActionMeta{Key: "export", Label: "导出", Scope: "both"},
			meta.ActionMeta{Key: "batch_print", Label: "批量打印", Scope: "batch"},
		)
	}
	destroy := spec.headDestroy
	return meta.ResourceMeta{
		Name: spec.headResource, PermissionPrefix: spec.prefix, PermissionLabel: spec.label,
		Table: spec.headTable, Fields: fields, Actions: actions,
		Print: side == SideSales, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ItemResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	orderResource, quoteResource := spec.headResource, "salQuotationItems"
	partyLabel := "对手类型(客户/内部公司)"
	variants := []meta.GridColumnRefVariant{
		{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
		{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
	}
	if side == SidePurchase {
		quoteResource, partyLabel = "purQuotationItems", "对手类型(供应商/内部公司)"
		variants = []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
		}
	}
	orderRel, companyRel, materialRel, unitRel, quoteRel := "order", "company", "material", "unit", "quotationItem"
	orderNo, name, materialCode := "orderNo", "name", "materialCode"
	orderRef := meta.Ref(orderResource, orderRel, orderNo)
	companyRef := meta.Ref("basCompanies", companyRel, name)
	materialRef := meta.Ref("invMaterials", materialRel, name)
	unitRef := meta.Ref("basUnits", unitRel, name)
	quoteRef := meta.Ref(quoteResource, quoteRel, materialCode)
	projectionName, projectionLabel, remainingLabel := "shipped_qty", "已发数量(物料默认单位,系统维护)", "未发数量(物料默认单位)"
	if side == SidePurchase {
		projectionName, projectionLabel, remainingLabel = "received_qty", "已收数量(物料默认单位,系统维护)", "未收数量(物料默认单位)"
	}
	fields := []meta.FieldMeta{
		meta.Field("id", "id", meta.TypeUUID, "id", true, false, true),
		meta.EnumField("idx", "idx", meta.TypeInteger, "行号", nil, false),
		meta.EnumField("qty", "qty", meta.TypeDecimal, "数量", nil, false),
		meta.EnumField("base_qty", "baseQty", meta.TypeDecimal, "订购数量(物料默认单位,系统折算)", nil, false),
		meta.EnumField(projectionName, apiName(projectionName), meta.TypeDecimal, projectionLabel, nil, false),
		meta.EnumField("price", "price", meta.TypeDecimal, "原币含税单价", nil, false),
		meta.EnumField("amount", "amount", meta.TypeDecimal, "原币含税金额(系统算:数量×原币单价)", nil, false),
		meta.EnumField("base_price", "basePrice", meta.TypeDecimal, "本币含税单价(系统算:原币单价×汇率,4位,仅展示参考)", nil, false),
		meta.EnumField("base_amount", "baseAmount", meta.TypeDecimal, "本币含税金额(系统算:原币金额×汇率)", nil, false),
		meta.EnumField("tax_rate", "taxRate", meta.TypeDecimal, "税率(小数,如 0.13)", nil, false),
		meta.EnumField("material_code", "materialCode", meta.TypeString, "物料编号", nil, false),
		meta.EnumField("material_name", "materialName", meta.TypeString, "物料名称", nil, false),
		meta.EnumField("material_spec", "materialSpec", meta.TypeString, "规格", nil, false),
		meta.EnumField("customer_part_no", "customerPartNo", meta.TypeString, "客户料号", nil, false),
		meta.EnumField("unit_name", "unitName", meta.TypeString, "单位名称", nil, false),
		meta.EnumField("remarks", "remarks", meta.TypeString, "行备注", nil, false),
	}
	if side == SidePurchase {
		fields = append(fields, meta.EnumField("demand_date", "demandDate", meta.TypeDate, "需求日(来自履约需求行,可空)", nil, false))
	}
	fields = append(fields,
		meta.EnumField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil, false),
		meta.EnumField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil, false),
		meta.RefField("order_id", "orderId", "订单", orderRef, false),
		meta.RefField("company_id", "companyId", "公司", companyRef, false),
		meta.RefField("material_id", "materialId", "物料", materialRef, false),
		meta.RefField("unit_id", "unitId", "单位", unitRef, false),
		meta.RefField("quotation_item_id", "quotationItemId", "报价条目", quoteRef, false),
	)
	if side == SidePurchase {
		fields = append(fields,
			meta.RefField("bom_id", "bomId", "成品 BOM(留痕,限条目物料自身)", meta.Ref("mfgBoms", "bom", "code"), false),
			meta.RefField("demand_line_id", "demandLineId", "来源履约需求行", meta.Ref("mfgDemandItems", "demandLine", "materialCode"), false),
		)
	}
	discriminator, discriminatorType := "partyType", "enum"
	fields = append(fields,
		meta.EnumField("order_date", "orderDate", meta.TypeDate, "订单日期", nil, false),
		meta.EnumField("order_status", "orderStatus", meta.TypeEnum, "状态", orderStatusOptions, false),
	)
	if side == SidePurchase {
		fields = append(fields, meta.EnumField("order_is_outsourced", "orderIsOutsourced", meta.TypeBoolean, "委外订单", nil, false))
	}
	fields = append(fields,
		meta.EnumField("party_type", "partyType", meta.TypeEnum, partyLabel, orderPartyOptions, false),
		meta.FieldMeta{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
		meta.EnumField("currency_code", "currencyCode", meta.TypeString, "币种", nil, false),
		meta.EnumField("remaining_base_qty", "remainingBaseQty", meta.TypeDecimal, remainingLabel, nil, false),
	)
	destroy := spec.itemDestroy
	return meta.ResourceMeta{Name: spec.itemResource, PermissionPrefix: spec.prefix, PermissionLabel: spec.label,
		Table: spec.itemTable, Fields: fields, Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}

func MaterialResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOrderItemMaterial"
	discriminator, discriminatorType := "partyType", "enum"
	partyRef := &meta.GridColumnRef{
		Discriminator:     &discriminator,
		DiscriminatorType: &discriminatorType,
		Variants: []meta.GridColumnRefVariant{
			{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
			{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
		},
	}
	fields := []meta.FieldMeta{
		meta.Field("id", "id", meta.TypeUUID, "id", true, false, true),
		meta.EnumField("quantity", "quantity", meta.TypeDecimal, "数量", nil, false),
		meta.EnumField("issued_qty", "issuedQty", meta.TypeDecimal, "已发料量(材料默认单位,系统维护)", nil, false),
		meta.EnumField("remarks", "remarks", meta.TypeString, "行备注", nil, false),
		meta.EnumField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil, false),
		meta.EnumField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil, false),
		meta.RefField("order_item_id", "orderItemId", "订单条目", meta.Ref("purOrderItems", "orderItem", "materialCode"), false),
		meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), false),
		meta.RefField("material_id", "materialId", "材料", meta.Ref("invMaterials", "material", "name"), false),
		meta.RefField("unit_id", "unitId", "单位", meta.Ref("basUnits", "unit", "name"), false),
		meta.EnumField("order_no", "orderNo", meta.TypeString, "订单号", nil, false),
		meta.EnumField("order_status", "orderStatus", meta.TypeEnum, "订单状态", orderStatusOptions, false),
		meta.EnumField("order_is_outsourced", "orderIsOutsourced", meta.TypeBoolean, "委外订单", nil, false),
		meta.EnumField("party_type", "partyType", meta.TypeEnum, "对手类型(供应商/内部公司)", orderPartyOptions, false),
		{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true, Ref: partyRef},
		meta.EnumField("remaining_issue_qty", "remainingIssueQty", meta.TypeDecimal, "剩余可发料量(材料默认单位)", nil, false),
	}
	return meta.ResourceMeta{Name: "purOrderItemMaterials", PermissionPrefix: "purchase.order",
		PermissionLabel: "采购订单", Table: "pur_order_item_material", Fields: fields,
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}

func ByproductResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOrderItemByproduct"
	fields := []meta.FieldMeta{
		meta.Field("id", "id", meta.TypeUUID, "id", true, false, true),
		meta.EnumField("quantity", "quantity", meta.TypeDecimal, "数量", nil, false),
		meta.EnumField("remarks", "remarks", meta.TypeString, "行备注", nil, false),
		meta.EnumField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil, false),
		meta.EnumField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil, false),
		meta.RefField("order_item_id", "orderItemId", "订单条目", meta.Ref("purOrderItems", "orderItem", "materialCode"), false),
		meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), false),
		meta.RefField("material_id", "materialId", "材料", meta.Ref("invMaterials", "material", "name"), false),
		meta.RefField("unit_id", "unitId", "单位", meta.Ref("basUnits", "unit", "name"), false),
	}
	return meta.ResourceMeta{Name: "purOrderItemByproducts", PermissionPrefix: "purchase.order",
		PermissionLabel: "采购订单", Table: "pur_order_item_byproduct", Fields: fields,
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}

func apiName(name string) string {
	switch name {
	case "shipped_qty":
		return "shippedQty"
	case "received_qty":
		return "receivedQty"
	default:
		return name
	}
}
