package gljournal

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	ResourceName     = "accGlJournals"
	LineResourceName = "accGlJournalLines"
)

var partyOptions = []meta.EnumOption{
	{Value: "SUPPLIER", Label: "供应商"},
	{Value: "CUSTOMER", Label: "客户"},
	{Value: "COMPANY", Label: "内部公司"},
	{Value: "EMPLOYEE", Label: "员工"},
}

var statusOptions = []meta.EnumOption{
	{Value: "DRAFT", Label: "草稿"},
	{Value: "AUDITED", Label: "已审核"},
	{Value: "CANCELLED", Label: "已取消"},
}

func ResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccGlJournal"
	company, user := "basCompanies", "sysUsers"
	companyRelation, createdRelation, submittedRelation := "company", "createdBy", "submittedBy"
	name := "name"
	return meta.ResourceMeta{
		Name: ResourceName, PermissionPrefix: "acc.gl_journal",
		PermissionLabel: "会计凭证", Table: "acc_gl_journal",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "voucher_no", APIName: "voucherNo", DBColumn: "voucher_no", Type: meta.TypeString, Label: "凭证编号", Required: true, Filterable: true, Sortable: true},
			{Name: "date", APIName: "date", DBColumn: "date", Type: meta.TypeDate, Label: "单据日期", Required: true, Filterable: true, Sortable: true},
			{Name: "posting_date", APIName: "postingDate", DBColumn: "posting_date", Type: meta.TypeDate, Label: "过账日期", Filterable: true, Sortable: true},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "凭证备注", Filterable: true, Sortable: true},
			{Name: "status", APIName: "status", DBColumn: "status", Type: meta.TypeEnum, Label: "状态", Readonly: true, EnumOptions: statusOptions, Filterable: true, Sortable: true},
			{Name: "submitted_at", APIName: "submittedAt", DBColumn: "submitted_at", Type: meta.TypeDatetime, Label: "提交时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRelation, LabelField: &name}},
			{Name: "created_by_id", APIName: "createdById", DBColumn: "created_by_id", Type: meta.TypeFK, Label: "编写人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &user, Relation: &createdRelation, LabelField: &name}},
			{Name: "submitted_by_id", APIName: "submittedById", DBColumn: "submitted_by_id", Type: meta.TypeFK, Label: "提交人", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &user, Relation: &submittedRelation, LabelField: &name}},
			{Name: "debit_total", APIName: "debitTotal", DBColumn: "debit_total", Type: meta.TypeDecimal, Label: "借方总金额", Readonly: true},
			{Name: "credit_total", APIName: "creditTotal", DBColumn: "credit_total", Type: meta.TypeDecimal, Label: "贷方总金额", Readonly: true},
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "audit", Label: "审核", Scope: "row", Mutation: "auditAccGlJournal"},
			{Key: "cancel", Label: "取消", Scope: "row", Mutation: "cancelAccGlJournal", IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func LineResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccGlJournalLine"
	discriminator, discriminatorType := "partyType", "enum"
	journal, company, account, currency := ResourceName, "basCompanies", "basAccounts", "basCurrencies"
	journalRelation, companyRelation, accountRelation, currencyRelation := "journal", "company", "account", "currency"
	voucherNo, name := "voucherNo", "name"
	return meta.ResourceMeta{
		Name: LineResourceName, PermissionPrefix: "acc.gl_journal",
		PermissionLabel: "会计凭证", Table: "acc_gl_journal_line",
		Fields: []meta.FieldMeta{
			{Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID, Label: "id", Readonly: true, Sortable: true},
			{Name: "idx", APIName: "idx", DBColumn: "idx", Type: meta.TypeInteger, Label: "行号", Required: true, Filterable: true, Sortable: true},
			{Name: "debit", APIName: "debit", DBColumn: "debit", Type: meta.TypeDecimal, Label: "借方金额", Required: true, Filterable: true, Sortable: true},
			{Name: "credit", APIName: "credit", DBColumn: "credit", Type: meta.TypeDecimal, Label: "贷方金额", Required: true, Filterable: true, Sortable: true},
			{Name: "party_type", APIName: "partyType", DBColumn: "party_type", Type: meta.TypeEnum, Label: "对手类型", EnumOptions: partyOptions, Filterable: true, Sortable: true},
			{Name: "party_id", APIName: "partyId", DBColumn: "party_id", Type: meta.TypeFK, Label: "对手", Filterable: true,
				Ref: &meta.GridColumnRef{Discriminator: &discriminator, DiscriminatorType: &discriminatorType,
					Variants: []meta.GridColumnRefVariant{
						{Value: "COMPANY", Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
						{Value: "CUSTOMER", Resource: "salCustomers", LabelField: "name", Label: "客户"},
						{Value: "EMPLOYEE", Resource: "hrEmployees", LabelField: "name", Label: "员工"},
						{Value: "SUPPLIER", Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
					}}},
			{Name: "remarks", APIName: "remarks", DBColumn: "remarks", Type: meta.TypeString, Label: "行备注", Filterable: true, Sortable: true},
			{Name: "inserted_at", APIName: "insertedAt", DBColumn: "inserted_at", Type: meta.TypeDatetime, Label: "创建时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "updated_at", APIName: "updatedAt", DBColumn: "updated_at", Type: meta.TypeDatetime, Label: "更新时间", Readonly: true, Filterable: true, Sortable: true},
			{Name: "journal_id", APIName: "journalId", DBColumn: "journal_id", Type: meta.TypeFK, Label: "凭证", Required: true, CreateOnly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &journal, Relation: &journalRelation, LabelField: &voucherNo}},
			{Name: "company_id", APIName: "companyId", DBColumn: "company_id", Type: meta.TypeFK, Label: "公司", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &company, Relation: &companyRelation, LabelField: &name}},
			{Name: "account_id", APIName: "accountId", DBColumn: "account_id", Type: meta.TypeFK, Label: "科目", Required: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &account, Relation: &accountRelation, LabelField: &name}},
			{Name: "currency_id", APIName: "currencyId", DBColumn: "currency_id", Type: meta.TypeFK, Label: "币种", Readonly: true, Filterable: true,
				Ref: &meta.GridColumnRef{Resource: &currency, Relation: &currencyRelation, LabelField: &name}},
		},
		Actions: []meta.ActionMeta{{Key: "read", Label: "查看", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}
