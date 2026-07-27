package settings

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	SalesResourceName         = "salSettings"
	ManufacturingResourceName = "mfgSettings"
	AccountingResourceName    = "accSettings"
	SystemResourceName        = "sysSettings"
)

func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{
		SalesResourceMeta(),
		ManufacturingResourceMeta(),
		AccountingResourceMeta(),
		SystemResourceMeta(),
	}
}

func SalesResourceMeta() meta.ResourceMeta {
	resource := settingMeta(
		SalesResourceName, "sales.setting", "供应链设置", "sal_setting",
		[]meta.FieldMeta{
			field("id", "id", meta.TypeUUID, "id", true, false),
			field("sample_item_max_qty", "sampleItemMaxQty", meta.TypeInteger, "样品订单条目数量上限", true, true),
			field("delivery_overship_ratio", "deliveryOvershipRatio", meta.TypeDecimal, "发货超发比例(小数,0=禁超发,0.05=5%,上限 1)", true, true),
			field("spot_item_max_qty", "spotItemMaxQty", meta.TypeInteger, "零星订单条目数量上限", true, true),
			field("receipt_overreceive_ratio", "receiptOverreceiveRatio", meta.TypeDecimal, "入库超收比例(小数,0=禁超收,0.05=5%,上限 1)", true, true),
			field("demand_overorder_ratio", "demandOverorderRatio", meta.TypeDecimal, "需求超下单比例(小数,0=禁超下单,0.05=5%,上限 1)", true, true),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
		},
		[]string{"id", "insertedAt", "updatedAt"},
	)
	// sales.setting 前缀下还有 salCompanyAccountDefaults，打印头资源须显式标记
	resource.PrintHead = true
	return resource
}

func ManufacturingResourceMeta() meta.ResourceMeta {
	return settingMeta(
		ManufacturingResourceName, "mfg.setting", "生产设置", "mfg_setting",
		[]meta.FieldMeta{
			field("id", "id", meta.TypeUUID, "id", true, false),
			field("output_overreceive_ratio", "outputOverreceiveRatio", meta.TypeDecimal, "生产入库超入比例(小数,0=禁超入,0.05=5%,上限 1)", true, true),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
		},
		[]string{"id", "insertedAt", "updatedAt"},
	)
}

func AccountingResourceMeta() meta.ResourceMeta {
	resource := settingMeta(
		AccountingResourceName, "acc.setting", "财务设置", "acc_setting",
		[]meta.FieldMeta{
			field("id", "id", meta.TypeUUID, "id", true, false),
			field("ocr_access_key_id", "ocrAccessKeyId", meta.TypeString, "阿里云 OCR AccessKey ID", true, true),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
		},
		[]string{"id", "insertedAt", "updatedAt"},
	)
	resource.Audit.SensitiveFields = []string{"ocr_access_key_secret"}
	return resource
}

func SystemResourceMeta() meta.ResourceMeta {
	return settingMeta(
		SystemResourceName, "sys.setting", "系统设置", "sys_setting",
		[]meta.FieldMeta{
			field("id", "id", meta.TypeUUID, "id", true, false),
			field("market_fetch_schedule_enabled", "marketFetchScheduleEnabled", meta.TypeBoolean, "启用行情定时拉取", true, true),
			field("market_fetch_last_interval_minutes", "marketFetchLastIntervalMinutes", meta.TypeInteger, "最新价拉取间隔(分钟,30/60/120)", true, true),
			field("market_fetch_settlement_enabled", "marketFetchSettlementEnabled", meta.TypeBoolean, "启用日终结算自动补拉", true, true),
			field("market_fetch_last_run_at", "marketFetchLastRunAt", meta.TypeDatetime, "上次行情拉取完成时刻", true, true),
			field("market_fetch_last_summary", "marketFetchLastSummary", meta.TypeString, "上次行情拉取结果摘要", true, true),
			field("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			field("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
		},
		[]string{"id", "marketFetchLastRunAt", "marketFetchLastSummary", "insertedAt", "updatedAt"},
	)
}

func settingMeta(
	name string,
	prefix string,
	label string,
	table string,
	fields []meta.FieldMeta,
	exclude []string,
) meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: name, PermissionPrefix: prefix, PermissionLabel: label, Table: table,
		Fields: fields, Print: true, Audit: meta.AuditMeta{Enabled: true},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
		},
		Form: &meta.FormMetaDTO{Exclude: exclude},
	}
}

func field(
	dbName string,
	apiName string,
	fieldType meta.FieldType,
	label string,
	sortable bool,
	filterable bool,
) meta.FieldMeta {
	return meta.FieldMeta{
		Name: dbName, APIName: apiName, DBColumn: dbName, Type: fieldType,
		Label: label, Sortable: sortable, Filterable: filterable,
	}
}
