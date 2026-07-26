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
		f("id", "id", meta.TypeUUID, "id", true, false, true),
		f("order_no", "orderNo", meta.TypeString, "订单号", true, true, true),
		enumF("order_date", "orderDate", meta.TypeDate, "订单日期", nil),
		enumF("order_type", "orderType", meta.TypeEnum, "订单类型", orderTypes),
	}
	if side == SidePurchase {
		fields = append(fields, enumF("is_outsourced", "isOutsourced", meta.TypeBoolean, "委外标记", nil))
	}
	discriminator, discriminatorType := "partyType", "enum"
	company, currency, user, name := "basCompanies", "basCurrencies", "sysUsers", "name"
	companyRel, currencyRel, createdRel, auditedRel := "company", "currency", "createdBy", "auditedBy"
	fields = append(fields,
		enumF("party_type", "partyType", meta.TypeEnum, partyLabel, orderPartyOptions),
		meta.FieldMeta{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
		enumF("exchange_rate", "exchangeRate", meta.TypeDecimal, "汇率(原币→本币)", nil),
		enumF("terms", "terms", meta.TypeString, termsLabel, nil),
		enumF("remarks", "remarks", meta.TypeString, "订单备注(对内)", nil),
		enumF("status", "status", meta.TypeEnum, "状态", orderStatusOptions),
		enumF("audited_at", "auditedAt", meta.TypeDatetime, "审核时间", nil),
		enumF("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil),
		enumF("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil),
		meta.FieldMeta{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
		meta.FieldMeta{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种(原币)", Required: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &currency, Relation: &currencyRel, LabelField: &name}},
		meta.FieldMeta{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "录入人", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &user, Relation: &createdRel, LabelField: &name}},
		meta.FieldMeta{Name: "audited_by_id", APIName: "auditedById", DBColumn: "audited_by_id", Type: meta.TypeFK, Label: "审核人", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Resource: &user, Relation: &auditedRel, LabelField: &name}},
		f("gross_total", "grossTotal", meta.TypeDecimal, "原币含税总额(行原币含税金额合计)", false, false, false),
		f("base_gross_total", "baseGrossTotal", meta.TypeDecimal, "本币含税总额(行本币含税金额合计)", false, false, false),
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
	orderRef := ref(orderResource, orderRel, orderNo)
	companyRef := ref("basCompanies", companyRel, name)
	materialRef := ref("invMaterials", materialRel, name)
	unitRef := ref("basUnits", unitRel, name)
	quoteRef := ref(quoteResource, quoteRel, materialCode)
	projectionName, projectionLabel, remainingLabel := "shipped_qty", "已发数量(物料默认单位,系统维护)", "未发数量(物料默认单位)"
	if side == SidePurchase {
		projectionName, projectionLabel, remainingLabel = "received_qty", "已收数量(物料默认单位,系统维护)", "未收数量(物料默认单位)"
	}
	fields := []meta.FieldMeta{
		f("id", "id", meta.TypeUUID, "id", true, false, true),
		enumF("idx", "idx", meta.TypeInteger, "行号", nil),
		enumF("qty", "qty", meta.TypeDecimal, "数量", nil),
		enumF("base_qty", "baseQty", meta.TypeDecimal, "订购数量(物料默认单位,系统折算)", nil),
		enumF(projectionName, apiName(projectionName), meta.TypeDecimal, projectionLabel, nil),
		enumF("price", "price", meta.TypeDecimal, "原币含税单价", nil),
		enumF("amount", "amount", meta.TypeDecimal, "原币含税金额(系统算:数量×原币单价)", nil),
		enumF("base_price", "basePrice", meta.TypeDecimal, "本币含税单价(系统算:原币单价×汇率,4位,仅展示参考)", nil),
		enumF("base_amount", "baseAmount", meta.TypeDecimal, "本币含税金额(系统算:原币金额×汇率)", nil),
		enumF("tax_rate", "taxRate", meta.TypeDecimal, "税率(小数,如 0.13)", nil),
		enumF("material_code", "materialCode", meta.TypeString, "物料编号", nil),
		enumF("material_name", "materialName", meta.TypeString, "物料名称", nil),
		enumF("material_spec", "materialSpec", meta.TypeString, "规格", nil),
		enumF("customer_part_no", "customerPartNo", meta.TypeString, "客户料号", nil),
		enumF("unit_name", "unitName", meta.TypeString, "单位名称", nil),
		enumF("remarks", "remarks", meta.TypeString, "行备注", nil),
	}
	if side == SidePurchase {
		fields = append(fields, enumF("demand_date", "demandDate", meta.TypeDate, "需求日(来自履约需求行,可空)", nil))
	}
	fields = append(fields,
		enumF("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil),
		enumF("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil),
		withRef("order_id", "orderId", "订单", orderRef),
		withRef("company_id", "companyId", "公司", companyRef),
		withRef("material_id", "materialId", "物料", materialRef),
		withRef("unit_id", "unitId", "单位", unitRef),
		withRef("quotation_item_id", "quotationItemId", "报价条目", quoteRef),
	)
	if side == SidePurchase {
		fields = append(fields,
			withRef("bom_id", "bomId", "成品 BOM(留痕,限条目物料自身)", ref("mfgBoms", "bom", "code")),
			withRef("demand_line_id", "demandLineId", "来源履约需求行", ref("mfgDemandItems", "demandLine", "materialCode")),
		)
	}
	discriminator, discriminatorType := "partyType", "enum"
	fields = append(fields,
		enumF("order_date", "orderDate", meta.TypeDate, "订单日期", nil),
		enumF("order_status", "orderStatus", meta.TypeEnum, "状态", orderStatusOptions),
	)
	if side == SidePurchase {
		fields = append(fields, enumF("order_is_outsourced", "orderIsOutsourced", meta.TypeBoolean, "委外订单", nil))
	}
	fields = append(fields,
		enumF("party_type", "partyType", meta.TypeEnum, partyLabel, orderPartyOptions),
		meta.FieldMeta{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true,
			Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
		enumF("currency_code", "currencyCode", meta.TypeString, "币种", nil),
		enumF("remaining_base_qty", "remainingBaseQty", meta.TypeDecimal, remainingLabel, nil),
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
		f("id", "id", meta.TypeUUID, "id", true, false, true),
		enumF("quantity", "quantity", meta.TypeDecimal, "数量", nil),
		enumF("issued_qty", "issuedQty", meta.TypeDecimal, "已发料量(材料默认单位,系统维护)", nil),
		enumF("remarks", "remarks", meta.TypeString, "行备注", nil),
		enumF("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil),
		enumF("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil),
		withRef("order_item_id", "orderItemId", "订单条目", ref("purOrderItems", "orderItem", "materialCode")),
		withRef("company_id", "companyId", "公司", ref("basCompanies", "company", "name")),
		withRef("material_id", "materialId", "材料", ref("invMaterials", "material", "name")),
		withRef("unit_id", "unitId", "单位", ref("basUnits", "unit", "name")),
		enumF("order_no", "orderNo", meta.TypeString, "订单号", nil),
		enumF("order_status", "orderStatus", meta.TypeEnum, "订单状态", orderStatusOptions),
		enumF("order_is_outsourced", "orderIsOutsourced", meta.TypeBoolean, "委外订单", nil),
		enumF("party_type", "partyType", meta.TypeEnum, "对手类型(供应商/内部公司)", orderPartyOptions),
		{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true, Ref: partyRef},
		enumF("remaining_issue_qty", "remainingIssueQty", meta.TypeDecimal, "剩余可发料量(材料默认单位)", nil),
	}
	return meta.ResourceMeta{Name: "purOrderItemMaterials", PermissionPrefix: "purchase.order",
		PermissionLabel: "采购订单", Table: "pur_order_item_material", Fields: fields,
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}

func ByproductResourceMeta() meta.ResourceMeta {
	destroy := "destroyPurOrderItemByproduct"
	fields := []meta.FieldMeta{
		f("id", "id", meta.TypeUUID, "id", true, false, true),
		enumF("quantity", "quantity", meta.TypeDecimal, "数量", nil),
		enumF("remarks", "remarks", meta.TypeString, "行备注", nil),
		enumF("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", nil),
		enumF("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", nil),
		withRef("order_item_id", "orderItemId", "订单条目", ref("purOrderItems", "orderItem", "materialCode")),
		withRef("company_id", "companyId", "公司", ref("basCompanies", "company", "name")),
		withRef("material_id", "materialId", "材料", ref("invMaterials", "material", "name")),
		withRef("unit_id", "unitId", "单位", ref("basUnits", "unit", "name")),
	}
	return meta.ResourceMeta{Name: "purOrderItemByproducts", PermissionPrefix: "purchase.order",
		PermissionLabel: "采购订单", Table: "pur_order_item_byproduct", Fields: fields,
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy}
}

func f(name, api string, typ meta.FieldType, label string, sortable, filterable, readonly bool) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: api, DBColumn: name, Type: typ, Label: label,
		Sortable: sortable, Filterable: filterable, Readonly: readonly}
}

func enumF(name, api string, typ meta.FieldType, label string, options []meta.EnumOption) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: api, DBColumn: name, Type: typ, Label: label,
		Sortable: true, Filterable: true, EnumOptions: options}
}

func ref(resource, relation, label string) *meta.GridColumnRef {
	return &meta.GridColumnRef{Resource: &resource, Relation: &relation, LabelField: &label}
}

func withRef(name, api, label string, reference *meta.GridColumnRef) meta.FieldMeta {
	return meta.FieldMeta{Name: name, APIName: api, DBColumn: name, Type: meta.TypeFK,
		Label: label, Filterable: true, Ref: reference}
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
