package quotation

import "github.com/z1coyan/synie/server/internal/platform/meta"

var partyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var statusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "VOIDED", Label: "已作废"},
}

var pricingOptions = []meta.EnumOption{
	{Value: "FIXED", Label: "固定价"},
	{Value: "QTY_TIERED", Label: "数量梯度"},
}

func QuotationResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	company, currency, user := "basCompanies", "basCurrencies", "sysUsers"
	companyRel, currencyRel, createdRel, auditedRel := "company", "currency", "createdBy", "auditedBy"
	name := "name"
	discriminator, discriminatorType := "partyType", "enum"
	variants := make([]meta.GridColumnRefVariant, 0, len(spec.partyVariants))
	for _, variant := range spec.partyVariants {
		variants = append(variants, meta.GridColumnRefVariant{
			Value: variant.value, Resource: variant.resource, LabelField: "name", Label: variant.label,
		})
	}
	destroy := spec.headDestroyMutation
	return meta.ResourceMeta{
		Name: spec.headResource, PermissionPrefix: spec.prefix,
		PermissionLabel: spec.label, Table: spec.headTable,
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "quotation_no", APIName: "quotationNo", DBColumn: "quotation_no", Type: meta.TypeString, Label: "报价单号", Required: true, Filterable: true, Sortable: true},
			{Name: "quotation_date", APIName: "quotationDate", DBColumn: "quotation_date", Type: meta.TypeDate, Label: "报价日期", Required: true, Filterable: true, Sortable: true},
			{Name: "valid_until", APIName: "validUntil", DBColumn: "valid_until", Type: meta.TypeDate, Label: "报价截止(含当日)", Required: true, Filterable: true, Sortable: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Label: spec.partyLabel, Required: true, EnumOptions: partyOptions, Filterable: true, Sortable: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
			{Name: "terms", APIName: "terms", DBColumn: "terms", Type: meta.TypeString, Label: spec.termsLabel, Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "报价备注(对内)", Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true},
			{Name: "audited_at", APIName: "auditedAt", DBColumn: "audited_at", Type: meta.TypeDatetime, Label: "审核时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &currency, Relation: &currencyRel, LabelField: &name}},
			{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "录入人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &user, Relation: &createdRel, LabelField: &name}},
			{Name: "audited_by_id", APIName: "auditedById", DBColumn: "audited_by_id", Type: meta.TypeFK, Label: "审核人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &user, Relation: &auditedRel, LabelField: &name}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "audit", Label: "审核", Scope: "row", Mutation: spec.auditMutation},
			{Key: "void", Label: "作废", Scope: "row", Mutation: spec.voidMutation, IsDanger: true},
		},
		Print: true, PrintHead: true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: spec.itemResource}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ItemResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	quotation, company, material, unit := spec.headResource, "basCompanies", "invMaterials", "basUnits"
	quotationRel, companyRel, materialRel, unitRel := "quotation", "company", "material", "unit"
	quotationNo, name := "quotationNo", "name"
	discriminator, discriminatorType := "partyType", "enum"
	variants := make([]meta.GridColumnRefVariant, 0, len(spec.partyVariants))
	for _, variant := range spec.partyVariants {
		variants = append(variants, meta.GridColumnRefVariant{
			Value: variant.value, Resource: variant.resource, LabelField: "name", Label: variant.label,
		})
	}
	destroy := spec.itemDestroyMutation
	return meta.ResourceMeta{
		Name: spec.itemResource, PermissionPrefix: spec.prefix,
		PermissionLabel: spec.label, Table: spec.itemTable,
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "idx", APIName: "idx", DBColumn: "idx", Type: meta.TypeInteger, Label: "行号", Required: true, Filterable: true, Sortable: true},
			{Name: "pricing_mode", APIName: "pricingMode", DBColumn: "pricing_mode", Type: meta.TypeEnum, Label: "定价模式", Required: true, EnumOptions: pricingOptions, Filterable: true, Sortable: true},
			{Name: "price", APIName: "price", DBColumn: "price", Type: meta.TypeDecimal, Label: "含税单价(固定价模式)", Filterable: true, Sortable: true},
			{Name: "tax_rate", APIName: "taxRate", DBColumn: "tax_rate", Type: meta.TypeDecimal, Label: "税率(小数,如 0.13)", Required: true, Filterable: true, Sortable: true},
			{Name: "material_code", APIName: "materialCode", DBColumn: "material_code", Type: meta.TypeString, Label: "物料编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_name", APIName: "materialName", DBColumn: "material_name", Type: meta.TypeString, Label: "物料名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_spec", APIName: "materialSpec", DBColumn: "material_spec", Type: meta.TypeString, Label: "规格", Readonly: true, Filterable: true, Sortable: true},
			{Name: "customer_part_no", APIName: "customerPartNo", DBColumn: "customer_part_no", Type: meta.TypeString, Label: "客户料号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "unit_name", APIName: "unitName", DBColumn: "unit_name", Type: meta.TypeString, Label: "单位名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "行备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "quotation_id", APIName: "quotationId", DBColumn: "quotation_id", Type: meta.TypeFK, Label: "报价单", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &quotation, Relation: &quotationRel, LabelField: &quotationNo}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
			{Name: "material_id", APIName: "materialId", DBColumn: "material_id", Type: meta.TypeFK, Label: "物料", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &material, Relation: &materialRel, LabelField: &name}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "单位", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &unit, Relation: &unitRel, LabelField: &name}},
			{Name: "tier_count", APIName: "tierCount", DBColumn: "tier_count", Type: meta.TypeInteger, Label: "价格档数", Readonly: true, Calculated: true},
			{Name: "quotation_date", APIName: "quotationDate", DBColumn: "quotation_date", Type: meta.TypeDate, Label: "报价日期", Readonly: true, Filterable: true, Sortable: true, Calculated: true},
			{Name: "valid_until", APIName: "validUntil", DBColumn: "valid_until", Type: meta.TypeDate, Label: "报价截止(含当日)", Readonly: true, Filterable: true, Sortable: true, Calculated: true},
			{Name: "quotation_status", APIName: "quotationStatus", DBColumn: "quotation_status", Type: meta.TypeEnum, Label: "状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true, Calculated: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Label: spec.partyLabel, Readonly: true, EnumOptions: partyOptions, Filterable: true, Sortable: true, Calculated: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true,
				PrintRawID: true,
				Ref:        &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType, Variants: variants}},
			{Name: "currency_code", APIName: "currencyCode", DBColumn: "currency_code", Type: meta.TypeString, Label: "币种", Readonly: true, Filterable: true, Sortable: true, Calculated: true},
		},
		Actions:    []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		PrintLoops: []meta.PrintLoopMeta{{Name: "tiers", Resource: spec.tierResource}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func TierResourceMeta(side Side) meta.ResourceMeta {
	spec := mustSpec(side)
	item, company := spec.itemResource, "basCompanies"
	itemRel, companyRel := "item", "company"
	materialCode, name := "materialCode", "name"
	destroy := spec.tierDestroyMutation
	return meta.ResourceMeta{
		Name: spec.tierResource, PermissionPrefix: spec.prefix,
		PermissionLabel: spec.label, Table: spec.tierTable,
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "min_qty", APIName: "minQty", DBColumn: "min_qty", Type: meta.TypeDecimal, Label: "起订量(≥ 该量适用本档价)", Required: true, Filterable: true, Sortable: true},
			{Name: "price", APIName: "price", DBColumn: "price", Type: meta.TypeDecimal, Label: "含税档价", Required: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "item_id", APIName: "itemId", DBColumn: "item_id", Type: meta.TypeFK, Label: "报价条目", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &item, Relation: &itemRel, LabelField: &materialCode}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRel, LabelField: &name}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func mustSpec(side Side) sideSpec {
	spec, ok := specs[side]
	if !ok {
		panic("unknown quotation side: " + string(side))
	}
	return spec
}
