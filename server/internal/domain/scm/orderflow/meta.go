package orderflow

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "scmOrderFlowItems"

var flowTypeOptions = []meta.EnumOption{
	{Value: "PURCHASE_RECEIPT", Label: "采购入库"},
	{Value: "OUTSOURCED_ISSUE", Label: "委外发料"},
	{Value: "OUTSOURCED_RECEIPT", Label: "委外入库"},
	{Value: "SALES_DELIVERY", Label: "销售发货"},
}

var statusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "VOIDED", Label: "已作废"},
}

func ResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "scm.order_flow",
		PermissionLabel: "订单收发货历史", Table: "scm_order_flow_item",
		ReadPermissionsAny: append([]string(nil), sourceReadPermissions...),
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeString, Label: "行标识(单据类型:来源行 id)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "flow_type", APIName: "flowType", DBColumn: "flow_type", Type: meta.TypeEnum, Label: "单据类型", Readonly: true, EnumOptions: flowTypeOptions, Filterable: true, Sortable: true},
			{Name: "voucher_no", APIName: "voucherNo", DBColumn: "voucher_no", Type: meta.TypeString, Label: "单据编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "voucher_date", APIName: "voucherDate", DBColumn: "voucher_date", Type: meta.TypeDate, Label: "单据日期", Readonly: true, Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "单据状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true},
			{Name: "qty", APIName: "qty", DBColumn: "qty", Type: meta.TypeDecimal, Label: "数量", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_code", APIName: "materialCode", DBColumn: "material_code", Type: meta.TypeString, Label: "物料编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_name", APIName: "materialName", DBColumn: "material_name", Type: meta.TypeString, Label: "物料名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "material_spec", APIName: "materialSpec", DBColumn: "material_spec", Type: meta.TypeString, Label: "规格", Readonly: true, Filterable: true, Sortable: true},
			{Name: "customer_part_no", APIName: "customerPartNo", DBColumn: "customer_part_no", Type: meta.TypeString, Label: "客户料号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "unit_name", APIName: "unitName", DBColumn: "unit_name", Type: meta.TypeString, Label: "单位名称", Readonly: true, Filterable: true, Sortable: true},
			{Name: "order_id", APIName: "orderId", DBColumn: "order_id", Type: meta.TypeUUID, Label: "订单", Readonly: true, Sortable: true},
			{Name: "order_item_id", APIName: "orderItemId", DBColumn: "order_item_id", Type: meta.TypeUUID, Label: "订单条目", Readonly: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeUUID, Label: "公司", Readonly: true, Sortable: true},
		},
		// 权限完全复用四种来源单据的 read OR，不进入权限目录。
		Actions: nil,
		Audit:   meta.AuditMeta{Enabled: false},
	}
}
