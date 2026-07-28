package companyaccountdefault

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "salCompanyAccountDefaults"

var auditedFields = []string{
	"company_id", "delivery_debit_account_id", "delivery_credit_account_id",
	"receipt_debit_account_id", "receipt_credit_account_id",
}

func ResourceMeta() meta.ResourceMeta {
	companyResource, companyRelation, nameField := "basCompanies", "company", "name"
	accountResource := "basAccounts"
	deliveryDebitRelation, deliveryCreditRelation := "deliveryDebitAccount", "deliveryCreditAccount"
	receiptDebitRelation, receiptCreditRelation := "receiptDebitAccount", "receiptCreditAccount"
	accountRef := func(relation *string) *meta.GridColumnRef {
		return &meta.GridColumnRef{Resource: &accountResource, Relation: relation, LabelField: &nameField}
	}
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "sales.setting",
		PermissionLabel: "供应链设置", Table: "sal_company_account_default",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true, Ref: &meta.GridColumnRef{Resource: &companyResource, Relation: &companyRelation, LabelField: &nameField}},
			{Name: "delivery_debit_account_id", APIName: "deliveryDebitAccountId", DBColumn: "delivery_debit_account_id", Type: meta.TypeFK, Label: "销售发货默认借方科目(未开票应收)", Filterable: true, Ref: accountRef(&deliveryDebitRelation)},
			{Name: "delivery_credit_account_id", APIName: "deliveryCreditAccountId", DBColumn: "delivery_credit_account_id", Type: meta.TypeFK, Label: "销售发货默认贷方科目", Filterable: true, Ref: accountRef(&deliveryCreditRelation)},
			{Name: "receipt_debit_account_id", APIName: "receiptDebitAccountId", DBColumn: "receipt_debit_account_id", Type: meta.TypeFK, Label: "采购入库默认借方科目", Filterable: true, Ref: accountRef(&receiptDebitRelation)},
			{Name: "receipt_credit_account_id", APIName: "receiptCreditAccountId", DBColumn: "receipt_credit_account_id", Type: meta.TypeFK, Label: "采购入库默认贷方科目(未开票应付)", Filterable: true, Ref: accountRef(&receiptCreditRelation)},
		},
		// 旧资源 permission_actions 为空：权限目录复用 sales.setting，
		// Grid 不暴露通用 CRUD capabilities，设置页用专用保存入口。
		Actions: nil,
		Form: &meta.FormMetaDTO{
			Exclude: []string{"id", "insertedAt", "updatedAt"},
			Fields:  map[string]map[string]any{"companyId": {"required": true, "edit": "createOnly"}},
		},
		Audit: meta.AuditMeta{Enabled: true},
	}
}
