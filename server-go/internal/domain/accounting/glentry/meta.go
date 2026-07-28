package glentry

import "github.com/z1coyan/synie/server/internal/platform/meta"

const ResourceName = "accGlEntries"

var partyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

func ResourceMeta() meta.ResourceMeta {
	partyDiscriminator, partyDiscriminatorType := "partyType", "enum"
	voucherDiscriminator, voucherDiscriminatorType := "voucherType", "string"
	company, account, currency := "basCompanies", "basAccounts", "basCurrencies"
	companyRelation, accountRelation, currencyRelation := "company", "account", "currency"
	name := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "acc.gl_entry",
		PermissionLabel: "总账分录", Table: "acc_gl_entry",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "seq", APIName: "seq", DBColumn: "seq", Type: meta.TypeInteger, Label: "序号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "posting_date", APIName: "postingDate", DBColumn: "posting_date", Type: meta.TypeDate, Label: "过账日期", Readonly: true, Filterable: true, Sortable: true},
			{Name: "debit", APIName: "debit", DBColumn: "debit", Type: meta.TypeDecimal, Label: "借方金额", Readonly: true, Filterable: true, Sortable: true},
			{Name: "credit", APIName: "credit", DBColumn: "credit", Type: meta.TypeDecimal, Label: "贷方金额", Readonly: true, Filterable: true, Sortable: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Label: "对手类型", Readonly: true, EnumOptions: partyOptions, Filterable: true, Sortable: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{
					Discriminator: &partyDiscriminator, DiscriminatorType: &partyDiscriminatorType,
					Variants: []meta.GridColumnRefVariant{
						{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
						{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
						{Value: "EMPLOYEE", Resource: "hrEmployees", LabelField: "name", Label: "员工"},
						{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
					},
				}},
			{Name: "voucher_type", APIName: "voucherType", DBColumn: "voucher_type", Type: meta.TypeString, Label: "来源单据类型", Readonly: true, Filterable: true, Sortable: true},
			{Name: "voucher_id", APIName: "voucherId", DBColumn: "voucher_id", Type: meta.TypeFK, Label: "来源单据", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{
					Discriminator: &voucherDiscriminator, DiscriminatorType: &voucherDiscriminatorType,
					Variants: []meta.GridColumnRefVariant{
						{Value: "acc.bill_transaction", Resource: "accBillTransactions", LabelField: "docNo", Label: "承兑交易"},
						{Value: "acc.expense_report", Resource: "accExpenseReports", LabelField: "docNo", Label: "报销单"},
						{Value: "acc.gl_journal", Resource: "accGlJournals", LabelField: "voucherNo", Label: "凭证"},
						{Value: "acc.vat_invoice", Resource: "accVatInvoices", LabelField: "docNo", Label: "增值税发票"},
						{Value: "purchase.outsourced_receipt", Resource: "purOutsourcedReceipts", LabelField: "receiptNo", Label: "委外入库单"},
						{Value: "purchase.receipt", Resource: "purReceipts", LabelField: "receiptNo", Label: "采购入库单"},
						{Value: "purchase.reconciliation", Resource: "purReconciliations", LabelField: "reconciliationNo", Label: "采购对账单"},
						{Value: "sales.delivery", Resource: "salDeliveries", LabelField: "deliveryNo", Label: "销售发货单"},
						{Value: "sales.reconciliation", Resource: "salReconciliations", LabelField: "reconciliationNo", Label: "销售对账单"},
					},
				}},
			{Name: "voucher_no", APIName: "voucherNo", DBColumn: "voucher_no", Type: meta.TypeString, Label: "来源单据编号", Readonly: true, Filterable: true, Sortable: true},
			{Name: "is_cancelled", APIName: "isCancelled", DBColumn: "is_cancelled", Type: meta.TypeBoolean, Label: "已作废", Readonly: true, Filterable: true, Sortable: true},
			{Name: "is_reversed", APIName: "isReversed", DBColumn: "is_reversed", Type: meta.TypeBoolean, Label: "已被红冲(原凭证状态)", Readonly: true, Filterable: true, Sortable: true},
			{Name: "is_reversal", APIName: "isReversal", DBColumn: "is_reversal", Type: meta.TypeBoolean, Label: "红字冲销行", Readonly: true, Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "摘要", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRelation, LabelField: &name}},
			{Name: "account_id", APIName: "accountId", DBColumn: "account_id", Type: meta.TypeFK, Label: "科目", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &account, Relation: &accountRelation, LabelField: &name}},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &currency, Relation: &currencyRelation, LabelField: &name}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: false},
	}
}
