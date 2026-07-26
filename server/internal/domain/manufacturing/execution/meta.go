package execution

import "github.com/z1coyan/synie/server/internal/platform/meta"

var demandStatusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "CONFIRMED", Label: "已确认"},
	{Value: "CLOSED", Label: "已关闭"},
	{Value: "VOIDED", Label: "已作废"},
}

var fulfillmentOptions = []meta.EnumOption{
	{Value: "MAKE", Label: "自制"},
	{Value: "BUY", Label: "外购"},
	{Value: "OUTSOURCE", Label: "委外"},
	{Value: "STOCK", Label: "库存"},
}

var demandItemStatusOptions = []meta.EnumOption{
	{Value: "PENDING", Label: "待安排"},
	{Value: "SCHEDULED", Label: "已安排"},
	{Value: "COMPLETED", Label: "已完成"},
}

var workOrderStatusOptions = []meta.EnumOption{
	{Value: "IN_PROGRESS", Label: "进行中"},
	{Value: "COMPLETED", Label: "已完工"},
	{Value: "VOIDED", Label: "已作废"},
}

var outputStatusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "VOIDED", Label: "已作废"},
}

func DemandResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgDemand"
	return meta.ResourceMeta{
		Name: "mfgDemands", PermissionPrefix: "mfg.demand",
		PermissionLabel: "履约需求单", Table: "mfg_demand",
		Fields: []meta.FieldMeta{
			metaID(),
			metaScalar("demand_no", "demandNo", meta.TypeString, "需求单号"),
			metaScalar("demand_date", "demandDate", meta.TypeDate, "业务日期"),
			metaScalar("remarks", "remarks", meta.TypeString, "备注"),
			metaEnum("status", "status", "状态", demandStatusOptions),
			metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			metaRef("company_id", "companyId", "公司",
				"basCompanies", "company", "name"),
			metaRef("created_by_id", "createdById", "录入人",
				"sysUsers", "createdBy", "name"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "confirm", Label: "确认", Scope: "row", Mutation: "confirmMfgDemand"},
			{Key: "close", Label: "关闭", Scope: "row", Mutation: "closeMfgDemand"},
			{Key: "void", Label: "作废", Scope: "row",
				Mutation: "voidMfgDemand", IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func DemandItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgDemandItem"
	return meta.ResourceMeta{
		Name: "mfgDemandItems", PermissionPrefix: "mfg.demand",
		PermissionLabel: "履约需求单", Table: "mfg_demand_item",
		Fields: []meta.FieldMeta{
			metaID(),
			metaScalar("idx", "idx", meta.TypeInteger, "行号"),
			metaScalar("qty", "qty", meta.TypeDecimal, "数量"),
			metaScalar("base_qty", "baseQty", meta.TypeDecimal, "折算默认单位数量"),
			metaScalar("ordered_qty", "orderedQty", meta.TypeDecimal,
				"已下单数量(物料默认单位,系统维护)"),
			metaScalar("received_qty", "receivedQty", meta.TypeDecimal,
				"已收数量(物料默认单位,系统维护)"),
			metaScalar("need_date", "needDate", meta.TypeDate, "需求日"),
			metaEnum("fulfillment_method", "fulfillmentMethod",
				"履约方式", fulfillmentOptions),
			metaEnum("status", "status", "行状态", demandItemStatusOptions),
			metaScalar("material_code", "materialCode", meta.TypeString, "物料编号快照"),
			metaScalar("material_name", "materialName", meta.TypeString, "物料名称快照"),
			metaScalar("material_spec", "materialSpec", meta.TypeString, "物料规格快照"),
			metaScalar("unit_name", "unitName", meta.TypeString, "单位名称快照"),
			metaScalar("remarks", "remarks", meta.TypeString, "行备注"),
			metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			metaRef("demand_id", "demandId", "履约需求单",
				"mfgDemands", "demand", "demandNo"),
			metaRef("company_id", "companyId", "公司",
				"basCompanies", "company", "name"),
			metaRef("material_id", "materialId", "物料",
				"invMaterials", "material", "name"),
			metaRef("unit_id", "unitId", "单位",
				"basUnits", "unit", "name"),
			metaRef("sales_order_item_id", "salesOrderItemId", "来源销售订单条目(可空)",
				"salOrderItems", "salesOrderItem", "materialCode"),
			metaScalar("ordered", "ordered", meta.TypeBoolean,
				"已下单(有已审核订单条目且未完成)"),
			metaScalar("remaining_orderable_qty", "remainingOrderableQty", meta.TypeDecimal,
				"剩余可下单数量(物料默认单位)"),
		},
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func WorkOrderResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgWorkOrder"
	return meta.ResourceMeta{
		Name: "mfgWorkOrders", PermissionPrefix: "mfg.work_order",
		PermissionLabel: "生产工单", Table: "mfg_work_order",
		Fields: []meta.FieldMeta{
			metaID(),
			metaScalar("work_order_no", "workOrderNo", meta.TypeString, "工单号"),
			metaScalar("qty", "qty", meta.TypeDecimal, "工单数量(与需求行同单位)"),
			metaScalar("base_qty", "baseQty", meta.TypeDecimal, "工单数量(默认单位)"),
			metaScalar("received_base_qty", "receivedBaseQty", meta.TypeDecimal,
				"累计已入(默认单位)"),
			metaScalar("need_date", "needDate", meta.TypeDate, "需求日/交期"),
			metaScalar("material_code", "materialCode", meta.TypeString, "物料编号快照"),
			metaScalar("material_name", "materialName", meta.TypeString, "物料名称快照"),
			metaScalar("material_spec", "materialSpec", meta.TypeString, "物料规格快照"),
			metaScalar("unit_name", "unitName", meta.TypeString, "单位名称快照"),
			metaEnum("status", "status", "状态", workOrderStatusOptions),
			metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			metaRef("company_id", "companyId", "公司",
				"basCompanies", "company", "name"),
			metaRef("demand_id", "demandId", "来源需求单",
				"mfgDemands", "demand", "demandNo"),
			metaRef("demand_item_id", "demandItemId", "来源需求行",
				"mfgDemandItems", "demandItem", "materialCode"),
			metaRef("material_id", "materialId", "物料",
				"invMaterials", "material", "name"),
			metaRef("unit_id", "unitId", "单位",
				"basUnits", "unit", "name"),
			metaRef("created_by_id", "createdById", "生成人",
				"sysUsers", "createdBy", "name"),
			metaScalar("remaining_base_qty", "remainingBaseQty", meta.TypeDecimal,
				"未完成数量(默认单位)"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "void", Label: "作废", Scope: "row",
				Mutation: "voidMfgWorkOrder", IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func OutputResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgOutput"
	return meta.ResourceMeta{
		Name: "mfgOutputs", PermissionPrefix: "mfg.output",
		PermissionLabel: "生产入库单", Table: "mfg_output",
		Fields: []meta.FieldMeta{
			metaID(),
			metaScalar("output_no", "outputNo", meta.TypeString, "入库单号"),
			metaScalar("output_date", "outputDate", meta.TypeDate,
				"入库日期(库存分录业务日)"),
			metaScalar("remarks", "remarks", meta.TypeString, "备注"),
			metaEnum("status", "status", "状态", outputStatusOptions),
			metaScalar("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
			metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			metaRef("company_id", "companyId", "公司",
				"basCompanies", "company", "name"),
			metaRef("warehouse_id", "warehouseId", "默认仓库(可空,仅新建行预填)",
				"invWarehouses", "warehouse", "name"),
			metaRef("created_by_id", "createdById", "录入人",
				"sysUsers", "createdBy", "name"),
			metaRef("audited_by_id", "auditedById", "审核人",
				"sysUsers", "auditedBy", "name"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "audit", Label: "审核", Scope: "row", Mutation: "auditMfgOutput"},
			{Key: "void", Label: "作废", Scope: "row",
				Mutation: "voidMfgOutput", IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func OutputItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyMfgOutputItem"
	return meta.ResourceMeta{
		Name: "mfgOutputItems", PermissionPrefix: "mfg.output",
		PermissionLabel: "生产入库单", Table: "mfg_output_item",
		Fields: []meta.FieldMeta{
			metaID(),
			metaScalar("idx", "idx", meta.TypeInteger, "行号"),
			metaScalar("qty", "qty", meta.TypeDecimal, "数量"),
			metaScalar("base_qty", "baseQty", meta.TypeDecimal, "折算默认单位数量"),
			metaScalar("material_code", "materialCode", meta.TypeString, "物料编号快照"),
			metaScalar("material_name", "materialName", meta.TypeString, "物料名称快照"),
			metaScalar("material_spec", "materialSpec", meta.TypeString, "物料规格快照"),
			metaScalar("unit_name", "unitName", meta.TypeString, "单位名称快照"),
			metaScalar("remarks", "remarks", meta.TypeString, "行备注"),
			metaScalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			metaScalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			metaRef("output_id", "outputId", "生产入库单",
				"mfgOutputs", "output", "outputNo"),
			metaRef("company_id", "companyId", "公司",
				"basCompanies", "company", "name"),
			metaRef("work_order_id", "workOrderId", "生产工单",
				"mfgWorkOrders", "workOrder", "workOrderNo"),
			metaRef("material_id", "materialId", "物料",
				"invMaterials", "material", "name"),
			metaRef("unit_id", "unitId", "单位",
				"basUnits", "unit", "name"),
			metaRef("warehouse_id", "warehouseId", "入库仓库",
				"invWarehouses", "warehouse", "name"),
		},
		Actions:         []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:           meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func metaID() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID,
		Label: "id", Readonly: true, Sortable: true,
	}
}

func metaScalar(name, api string, kind meta.FieldType, label string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: kind, Label: label,
		Filterable: true, Sortable: true,
	}
}

func metaEnum(name, api, label string, options []meta.EnumOption) meta.FieldMeta {
	field := metaScalar(name, api, meta.TypeEnum, label)
	field.EnumOptions = options
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
