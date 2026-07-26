package banking

import "github.com/z1coyan/synie/server/internal/platform/meta"

const (
	BankAccountResource        = "accBankAccounts"
	BankTransactionResource    = "accBankTransactions"
	BankImportTemplateResource = "accBankImportTemplates"
	BankImportResource         = "accBankImports"
	BankImportItemResource     = "accBankImportItems"
	BankReconciliationResource = "accBankReconciliations"
)

func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{
		BankAccountResourceMeta(),
		BankTransactionResourceMeta(),
		BankImportTemplateResourceMeta(),
		BankImportResourceMeta(),
		BankImportItemResourceMeta(),
		BankReconciliationResourceMeta(),
	}
}

func BankAccountResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankAccount"
	return meta.ResourceMeta{
		Name: BankAccountResource, PermissionPrefix: "acc.bank_account",
		PermissionLabel: "银行账户", Table: "acc_bank_account",
		Fields: []meta.FieldMeta{
			idField(),
			scalar("alias", "alias", meta.TypeString, "账户别名", true, true),
			scalar("bank_name", "bankName", meta.TypeString, "所属银行", true, true),
			scalar("branch_name", "branchName", meta.TypeString, "开户支行", true, true),
			scalar("holder_name", "holderName", meta.TypeString, "户名", true, true),
			scalar("account_no", "accountNo", meta.TypeString, "银行账号", true, true),
			scalar("active", "active", meta.TypeBoolean, "启用", true, true),
			scalar("note", "note", meta.TypeString, "备注", true, true),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("currency_id", "currencyId", "货币", "basCurrencies", "currency", "name"),
			ref("account_id", "accountId", "绑定科目", "basAccounts", "account", "name"),
		},
		Actions: crudActions(), Audit: meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func BankTransactionResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankTransaction"
	return meta.ResourceMeta{
		Name: BankTransactionResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_transaction",
		Fields: []meta.FieldMeta{
			idField(),
			scalar("occurred_at", "occurredAt", meta.TypeDatetime, "交易时间", true, true),
			scalar("income", "income", meta.TypeDecimal, "收入金额", true, true),
			scalar("expense", "expense", meta.TypeDecimal, "支出金额", true, true),
			scalar("balance", "balance", meta.TypeDecimal, "余额", true, true),
			scalar("counterparty_name", "counterpartyName", meta.TypeString, "对方户名", true, true),
			scalar("counterparty_account", "counterpartyAccount", meta.TypeString, "对方账号", true, true),
			scalar("summary", "summary", meta.TypeString, "摘要", true, true),
			scalar("note", "note", meta.TypeString, "备注", true, true),
			scalar("reconciled_amount", "reconciledAmount", meta.TypeDecimal, "已对账金额", true, true),
			scalar("unreconciled_amount", "unreconciledAmount", meta.TypeDecimal, "未对账金额", true, true),
			enum("reconcile_status", "reconcileStatus", "对账状态", []meta.EnumOption{
				{Value: ReconcileUnreconciled, Label: "未对账"},
				{Value: ReconcilePartial, Label: "部分对账"},
				{Value: ReconcileReconciled, Label: "已对账"},
			}),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("bank_account_id", "bankAccountId", "银行账户", BankAccountResource, "bankAccount", "alias"),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "update", Label: "编辑", Scope: "row"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
			{Key: "import", Label: "导入", Scope: "both"},
			// 旧 GridMeta 把 reconcile 作为 capability 而不是 extended action。
			{Key: "export", PermissionAction: "reconcile", Label: "对账", Scope: "both"},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BankImportTemplateResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankImportTemplate"
	return meta.ResourceMeta{
		Name: BankImportTemplateResource, PermissionPrefix: "acc.bank_import_template",
		PermissionLabel: "流水导入模板", Table: "acc_bank_import_template",
		Fields: []meta.FieldMeta{
			idField(),
			scalar("name", "name", meta.TypeString, "模板名称", true, true),
			scalar("start_row", "startRow", meta.TypeInteger, "起始行", true, true),
			scalar("datetime_col", "datetimeCol", meta.TypeString, "日期时间列", true, true),
			enum("datetime_format", "datetimeFormat", "日期时间格式", datetimeFormatOptions),
			scalar("date_col", "dateCol", meta.TypeString, "日期列", true, true),
			enum("date_format", "dateFormat", "日期格式", dateFormatOptions),
			scalar("time_col", "timeCol", meta.TypeString, "时间列", true, true),
			enum("time_format", "timeFormat", "时间格式", timeFormatOptions),
			scalar("income_col", "incomeCol", meta.TypeString, "收入金额列", true, true),
			scalar("expense_col", "expenseCol", meta.TypeString, "支出金额列", true, true),
			scalar("amount_col", "amountCol", meta.TypeString, "金额列(带符号)", true, true),
			scalar("balance_col", "balanceCol", meta.TypeString, "余额列", true, true),
			scalar("counterparty_name_col", "counterpartyNameCol", meta.TypeString, "对方户名列", true, true),
			scalar("counterparty_account_col", "counterpartyAccountCol", meta.TypeString, "对方账号列", true, true),
			scalar("summary_col", "summaryCol", meta.TypeString, "摘要列", true, true),
			scalar("note_col", "noteCol", meta.TypeString, "备注列", true, true),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("bank_account_id", "bankAccountId", "银行账户", BankAccountResource, "bankAccount", "alias"),
		},
		Actions: crudActions(), Audit: meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func BankImportResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankImport"
	return meta.ResourceMeta{
		Name: BankImportResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_import",
		Fields: []meta.FieldMeta{
			idField(),
			enum("status", "status", "状态", []meta.EnumOption{
				{Value: ImportParsed, Label: "已解析"},
				{Value: ImportFailed, Label: "解析失败"},
				{Value: ImportImported, Label: "已导入"},
			}),
			scalar("error", "error", meta.TypeString, "解析失败原因", true, true),
			scalar("imported_at", "importedAt", meta.TypeDatetime, "导入时间", true, true),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("bank_account_id", "bankAccountId", "银行账户", BankAccountResource, "bankAccount", "alias"),
			ref("template_id", "templateId", "导入模板", BankImportTemplateResource, "template", "name"),
			ref("file_id", "fileId", "导入文件", "sysFiles", "file", "filename"),
			ref("created_by_id", "createdById", "发起人", "sysUsers", "createdBy", "name"),
			ref("imported_by_id", "importedById", "导入人", "sysUsers", "importedBy", "name"),
			scalar("item_count", "itemCount", meta.TypeInteger, "行数", false, false),
			scalar("error_count", "errorCount", meta.TypeInteger, "错误行数", false, false),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BankImportItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankImportItem"
	return meta.ResourceMeta{
		Name: BankImportItemResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_import_item",
		Fields: []meta.FieldMeta{
			idField(),
			scalar("row_no", "rowNo", meta.TypeInteger, "行号", true, true),
			scalar("occurred_at", "occurredAt", meta.TypeDatetime, "交易时间", true, true),
			scalar("income", "income", meta.TypeDecimal, "收入金额", true, true),
			scalar("expense", "expense", meta.TypeDecimal, "支出金额", true, true),
			scalar("balance", "balance", meta.TypeDecimal, "余额", true, true),
			scalar("counterparty_name", "counterpartyName", meta.TypeString, "对方户名", true, true),
			scalar("counterparty_account", "counterpartyAccount", meta.TypeString, "对方账号", true, true),
			scalar("summary", "summary", meta.TypeString, "摘要", true, true),
			scalar("note", "note", meta.TypeString, "备注", true, true),
			scalar("error", "error", meta.TypeString, "行错误", true, true),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("import_id", "importId", "导入记录", BankImportResource, "import", "error"),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("transaction_id", "transactionId", "生成的银行流水", BankTransactionResource, "transaction", "summary"),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BankReconciliationResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankReconciliation"
	return meta.ResourceMeta{
		Name: BankReconciliationResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_reconciliation",
		Fields: []meta.FieldMeta{
			idField(),
			scalar("amount", "amount", meta.TypeDecimal, "对账金额", true, true),
			scalar("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			scalar("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			ref("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			ref("bank_transaction_id", "bankTransactionId", "银行流水", BankTransactionResource, "bankTransaction", "summary"),
			ref("journal_id", "journalId", "凭证", "accGlJournals", "journal", "voucherNo"),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

var datetimeFormatOptions = []meta.EnumOption{
	{Value: "YMD_DASH_HMS", Label: "YYYY-MM-DD HH:mm:ss"},
	{Value: "YMD_DASH_HM", Label: "YYYY-MM-DD HH:mm"},
	{Value: "YMD_SLASH_HMS", Label: "YYYY/MM/DD HH:mm:ss"},
	{Value: "YMD_SLASH_HM", Label: "YYYY/MM/DD HH:mm"},
	{Value: "COMPACT_SPACE", Label: "YYYYMMDD HHmmss"},
	{Value: "COMPACT", Label: "YYYYMMDDHHmmss"},
	{Value: "ISO_T", Label: "YYYY-MM-DDTHH:mm:ss"},
	{Value: "CN_HMS", Label: "YYYY年MM月DD日 HH:mm:ss"},
	{Value: "MDY_SLASH_HMS", Label: "MM/DD/YYYY HH:mm:ss"},
	{Value: "DMY_SLASH_HMS", Label: "DD/MM/YYYY HH:mm:ss"},
}

var dateFormatOptions = []meta.EnumOption{
	{Value: "YMD_DASH", Label: "YYYY-MM-DD"},
	{Value: "YMD_SLASH", Label: "YYYY/MM/DD"},
	{Value: "YMD_COMPACT", Label: "YYYYMMDD"},
	{Value: "YMD_DOT", Label: "YYYY.MM.DD"},
	{Value: "YMD_CN", Label: "YYYY年MM月DD日"},
	{Value: "MDY_SLASH", Label: "MM/DD/YYYY"},
	{Value: "DMY_SLASH", Label: "DD/MM/YYYY"},
	{Value: "DMY_DASH", Label: "DD-MM-YYYY"},
}

var timeFormatOptions = []meta.EnumOption{
	{Value: "HMS", Label: "HH:mm:ss"},
	{Value: "HM", Label: "HH:mm"},
	{Value: "HMS_COMPACT", Label: "HHmmss"},
	{Value: "HMS_CN", Label: "HH时mm分ss秒"},
}

func idField() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID,
		Label: "id", Readonly: true, Sortable: true,
	}
}

func scalar(name, api string, typ meta.FieldType, label string, filterable, sortable bool) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: typ, Label: label,
		Readonly: true, Filterable: filterable, Sortable: sortable,
	}
}

func enum(name, api, label string, options []meta.EnumOption) meta.FieldMeta {
	value := scalar(name, api, meta.TypeEnum, label, true, true)
	value.EnumOptions = options
	return value
}

func ref(name, api, label, resource, relation, labelField string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: meta.TypeFK, Label: label,
		Readonly: true, Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}

func crudActions() []meta.ActionMeta {
	return []meta.ActionMeta{
		{Key: "read", Label: "查看", Scope: "both"},
		{Key: "create", Label: "新增", Scope: "both"},
		{Key: "update", Label: "编辑", Scope: "row"},
		{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
	}
}
