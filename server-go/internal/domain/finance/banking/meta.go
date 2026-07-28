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
			meta.IDField(),
			meta.ScalarField("alias", "alias", meta.TypeString, "账户别名", true, true),
			meta.ScalarField("bank_name", "bankName", meta.TypeString, "所属银行", true, true),
			meta.ScalarField("branch_name", "branchName", meta.TypeString, "开户支行", true, true),
			meta.ScalarField("holder_name", "holderName", meta.TypeString, "户名", true, true),
			meta.ScalarField("account_no", "accountNo", meta.TypeString, "银行账号", true, true),
			meta.ScalarField("active", "active", meta.TypeBoolean, "启用", true, true),
			meta.ScalarField("note", "note", meta.TypeString, "备注", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("currency_id", "currencyId", "货币", meta.Ref("basCurrencies", "currency", "name"), true),
			meta.RefField("account_id", "accountId", "绑定科目", meta.Ref("basAccounts", "account", "name"), true),
		},
		Actions: meta.CRUDActions(), Audit: meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func BankTransactionResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankTransaction"
	return meta.ResourceMeta{
		Name: BankTransactionResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_transaction",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("occurred_at", "occurredAt", meta.TypeDatetime, "交易时间", true, true),
			meta.ScalarField("income", "income", meta.TypeDecimal, "收入金额", true, true),
			meta.ScalarField("expense", "expense", meta.TypeDecimal, "支出金额", true, true),
			meta.ScalarField("balance", "balance", meta.TypeDecimal, "余额", true, true),
			meta.ScalarField("counterparty_name", "counterpartyName", meta.TypeString, "对方户名", true, true),
			meta.ScalarField("counterparty_account", "counterpartyAccount", meta.TypeString, "对方账号", true, true),
			meta.ScalarField("summary", "summary", meta.TypeString, "摘要", true, true),
			meta.ScalarField("note", "note", meta.TypeString, "备注", true, true),
			meta.ScalarField("reconciled_amount", "reconciledAmount", meta.TypeDecimal, "已对账金额", true, true),
			meta.ScalarField("unreconciled_amount", "unreconciledAmount", meta.TypeDecimal, "未对账金额", true, true),
			meta.EnumField("reconcile_status", "reconcileStatus", meta.TypeEnum, "对账状态", []meta.EnumOption{
				{Value: ReconcileUnreconciled, Label: "未对账"},
				{Value: ReconcilePartial, Label: "部分对账"},
				{Value: ReconcileReconciled, Label: "已对账"},
			}, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("bank_account_id", "bankAccountId", "银行账户", meta.Ref(BankAccountResource, "bankAccount", "alias"), true),
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
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "reconciliations", Resource: BankReconciliationResource}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BankImportTemplateResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankImportTemplate"
	return meta.ResourceMeta{
		Name: BankImportTemplateResource, PermissionPrefix: "acc.bank_import_template",
		PermissionLabel: "流水导入模板", Table: "acc_bank_import_template",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("name", "name", meta.TypeString, "模板名称", true, true),
			meta.ScalarField("start_row", "startRow", meta.TypeInteger, "起始行", true, true),
			meta.ScalarField("datetime_col", "datetimeCol", meta.TypeString, "日期时间列", true, true),
			meta.EnumField("datetime_format", "datetimeFormat", meta.TypeEnum, "日期时间格式", datetimeFormatOptions, true),
			meta.ScalarField("date_col", "dateCol", meta.TypeString, "日期列", true, true),
			meta.EnumField("date_format", "dateFormat", meta.TypeEnum, "日期格式", dateFormatOptions, true),
			meta.ScalarField("time_col", "timeCol", meta.TypeString, "时间列", true, true),
			meta.EnumField("time_format", "timeFormat", meta.TypeEnum, "时间格式", timeFormatOptions, true),
			meta.ScalarField("income_col", "incomeCol", meta.TypeString, "收入金额列", true, true),
			meta.ScalarField("expense_col", "expenseCol", meta.TypeString, "支出金额列", true, true),
			meta.ScalarField("amount_col", "amountCol", meta.TypeString, "金额列(带符号)", true, true),
			meta.ScalarField("balance_col", "balanceCol", meta.TypeString, "余额列", true, true),
			meta.ScalarField("counterparty_name_col", "counterpartyNameCol", meta.TypeString, "对方户名列", true, true),
			meta.ScalarField("counterparty_account_col", "counterpartyAccountCol", meta.TypeString, "对方账号列", true, true),
			meta.ScalarField("summary_col", "summaryCol", meta.TypeString, "摘要列", true, true),
			meta.ScalarField("note_col", "noteCol", meta.TypeString, "备注列", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("bank_account_id", "bankAccountId", "银行账户", meta.Ref(BankAccountResource, "bankAccount", "alias"), true),
		},
		Actions: meta.CRUDActions(), Audit: meta.AuditMeta{Enabled: true},
		DestroyMutation: &destroy,
	}
}

func BankImportResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBankImport"
	return meta.ResourceMeta{
		Name: BankImportResource, PermissionPrefix: "acc.bank_transaction",
		PermissionLabel: "银行流水", Table: "acc_bank_import",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.EnumField("status", "status", meta.TypeEnum, "状态", []meta.EnumOption{
				{Value: ImportParsed, Label: "已解析"},
				{Value: ImportFailed, Label: "解析失败"},
				{Value: ImportImported, Label: "已导入"},
			}, true),
			meta.ScalarField("error", "error", meta.TypeString, "解析失败原因", true, true),
			meta.ScalarField("imported_at", "importedAt", meta.TypeDatetime, "导入时间", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("bank_account_id", "bankAccountId", "银行账户", meta.Ref(BankAccountResource, "bankAccount", "alias"), true),
			meta.RefField("template_id", "templateId", "导入模板", meta.Ref(BankImportTemplateResource, "template", "name"), true),
			meta.RefField("file_id", "fileId", "导入文件", meta.Ref("sysFiles", "file", "filename"), true),
			meta.RefField("created_by_id", "createdById", "发起人", meta.Ref("sysUsers", "createdBy", "name"), true),
			meta.RefField("imported_by_id", "importedById", "导入人", meta.Ref("sysUsers", "importedBy", "name"), true),
			meta.ScalarField("item_count", "itemCount", meta.TypeInteger, "行数", false, false),
			meta.ScalarField("error_count", "errorCount", meta.TypeInteger, "错误行数", false, false),
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
			meta.IDField(),
			meta.ScalarField("row_no", "rowNo", meta.TypeInteger, "行号", true, true),
			meta.ScalarField("occurred_at", "occurredAt", meta.TypeDatetime, "交易时间", true, true),
			meta.ScalarField("income", "income", meta.TypeDecimal, "收入金额", true, true),
			meta.ScalarField("expense", "expense", meta.TypeDecimal, "支出金额", true, true),
			meta.ScalarField("balance", "balance", meta.TypeDecimal, "余额", true, true),
			meta.ScalarField("counterparty_name", "counterpartyName", meta.TypeString, "对方户名", true, true),
			meta.ScalarField("counterparty_account", "counterpartyAccount", meta.TypeString, "对方账号", true, true),
			meta.ScalarField("summary", "summary", meta.TypeString, "摘要", true, true),
			meta.ScalarField("note", "note", meta.TypeString, "备注", true, true),
			meta.ScalarField("error", "error", meta.TypeString, "行错误", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("import_id", "importId", "导入记录", meta.Ref(BankImportResource, "import", "error"), true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("transaction_id", "transactionId", "生成的银行流水", meta.Ref(BankTransactionResource, "transaction", "summary"), true),
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
			meta.IDField(),
			meta.ScalarField("amount", "amount", meta.TypeDecimal, "对账金额", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), true),
			meta.RefField("bank_transaction_id", "bankTransactionId", "银行流水", meta.Ref(BankTransactionResource, "bankTransaction", "summary"), true),
			meta.RefField("journal_id", "journalId", "凭证", meta.Ref("accGlJournals", "journal", "voucherNo"), true),
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
