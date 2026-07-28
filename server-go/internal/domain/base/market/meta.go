package market

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	InstrumentResourceName = "basMarketInstruments"
	PricePointResourceName = "basMarketPricePoints"
)

var (
	instrumentAuditFields = []string{
		"code", "name", "source_type", "default_price_kind", "active", "fetch_enabled",
		"external_last_code", "external_product_group", "note", "currency_id", "unit_id",
	}
	pricePointAuditFields = []string{
		"observed_at", "price", "price_kind", "source", "is_voided", "note",
		"instrument_id", "currency_id", "unit_id",
	}
	sourceTypes = []meta.EnumOption{
		{Value: "EXCHANGE", Label: "交易所序列"},
		{Value: "SPOT_INDEX", Label: "现货指数"},
		{Value: "OTHER", Label: "其他"},
	}
	priceKinds = []meta.EnumOption{
		{Value: "SETTLEMENT", Label: "结算价"},
		{Value: "AVERAGE", Label: "均价"},
		{Value: "LAST", Label: "最新价"},
	}
	priceSources = []meta.EnumOption{
		{Value: "MANUAL", Label: "手工"},
		{Value: "FETCH", Label: "拉取"},
	}
)

func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{InstrumentResourceMeta(), PricePointResourceMeta()}
}

func InstrumentResourceMeta() meta.ResourceMeta {
	currencyResource, currencyRelation, currencyLabel := "basCurrencies", "currency", "name"
	unitResource, unitRelation, unitLabel := "basUnits", "unit", "name"
	destroy := "destroyBasMarketInstrument"
	return meta.ResourceMeta{
		Name: InstrumentResourceName, PermissionPrefix: "base.market_instrument",
		PermissionLabel: "行情品种", Table: "bas_market_instrument",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "code", APIName: "code", DBColumn: "code", Type: meta.TypeString, Label: "编码", Required: true, CreateOnly: true, Filterable: true, Sortable: true},
			{Name: "name", APIName: "name", DBColumn: "name", Type: meta.TypeString, Label: "名称", Required: true, Filterable: true, Sortable: true},
			{Name: "source_type", APIName: "sourceType", DBColumn: "source_type", Type: meta.TypeEnum, Label: "来源类型", Required: true, CreateOnly: true, EnumOptions: sourceTypes, Filterable: true, Sortable: true},
			{Name: "default_price_kind", APIName: "defaultPriceKind", DBColumn: "default_price_kind", Type: meta.TypeEnum, Label: "默认价类", Required: true, EnumOptions: priceKinds, Filterable: true, Sortable: true},
			{Name: "active", APIName: "active", DBColumn: "active", Type: meta.TypeBoolean, Label: "启用", Filterable: true, Sortable: true},
			{Name: "fetch_enabled", APIName: "fetchEnabled", DBColumn: "fetch_enabled", Type: meta.TypeBoolean, Label: "启用拉取", Filterable: true, Sortable: true},
			{Name: "external_last_code", APIName: "externalLastCode", DBColumn: "external_last_code", Type: meta.TypeString, Label: "外部最新价代码(如 CU0 主连)", Filterable: true, Sortable: true},
			{Name: "external_product_group", APIName: "externalProductGroup", DBColumn: "external_product_group", Type: meta.TypeString, Label: "外部品种组(如上期所日数据 cu)", Filterable: true, Sortable: true},
			{Name: "note", APIName: "note", DBColumn: "note", Type: meta.TypeString, Label: "备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Required: true, CreateOnly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &currencyResource, Relation: &currencyRelation, LabelField: &currencyLabel}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "计量单位", Required: true, CreateOnly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &unitLabel}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Form:  &meta.FormMetaDTO{Exclude: []string{"id", "insertedAt", "updatedAt"}},
		Print: true, Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func PricePointResourceMeta() meta.ResourceMeta {
	instrumentResource, instrumentRelation, instrumentLabel := InstrumentResourceName, "instrument", "name"
	currencyResource, currencyRelation, currencyLabel := "basCurrencies", "currency", "name"
	unitResource, unitRelation, unitLabel := "basUnits", "unit", "name"
	return meta.ResourceMeta{
		Name: PricePointResourceName, PermissionPrefix: "base.market_price",
		PermissionLabel: "行情价点", Table: "bas_market_price_point",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "observed_at", APIName: "observedAt", DBColumn: "observed_at", Type: meta.TypeDatetime, Label: "观测时刻", Required: true, Filterable: true, Sortable: true},
			{Name: "price", APIName: "price", DBColumn: "price", Type: meta.TypeDecimal, Label: "价格", Required: true, Filterable: true, Sortable: true},
			{Name: "price_kind", APIName: "priceKind", DBColumn: "price_kind", Type: meta.TypeEnum, Label: "价类", Required: true, EnumOptions: priceKinds, Filterable: true, Sortable: true},
			{Name: "source", APIName: "source", DBColumn: "source", Type: meta.TypeEnum, Label: "来源", Required: true, EnumOptions: priceSources, Filterable: true, Sortable: true},
			{Name: "is_voided", APIName: "isVoided", DBColumn: "is_voided", Type: meta.TypeBoolean, Label: "已作废", Readonly: true, Filterable: true, Sortable: true},
			{Name: "note", APIName: "note", DBColumn: "note", Type: meta.TypeString, Label: "备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "instrument_id", APIName: "instrumentId", DBColumn: "instrument_id", Type: meta.TypeFK, Label: "行情品种", Required: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &instrumentResource, Relation: &instrumentRelation, LabelField: &instrumentLabel}},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Required: true, Readonly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &currencyResource, Relation: &currencyRelation, LabelField: &currencyLabel}},
			{Name: "unit_id", APIName: "unitId", DBColumn: "unit_id", Type: meta.TypeFK, Label: "计量单位", Required: true, Readonly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &unitResource, Relation: &unitRelation, LabelField: &unitLabel}},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "void", Label: "作废", Scope: "row", Mutation: "voidBasMarketPricePoint", IsDanger: true},
		},
		Form:  &meta.FormMetaDTO{Exclude: []string{"id", "isVoided", "currencyId", "unitId", "insertedAt", "updatedAt"}},
		Print: true, Audit: meta.AuditMeta{Enabled: true},
	}
}
