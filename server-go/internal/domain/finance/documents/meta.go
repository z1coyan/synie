package documents

import "github.com/z1coyan/synie/server/internal/platform/meta"

var partyOptions = []meta.EnumOption{
	{Value: PartySupplier, Label: "供应商"},
	{Value: PartyCustomer, Label: "客户"},
	{Value: PartyCompany, Label: "内部公司"},
	{Value: PartyEmployee, Label: "员工"},
}

var partyVariants = []meta.GridColumnRefVariant{
	{Value: PartyCompany, Resource: "basCompanies", LabelField: "name", Label: "内部公司"},
	{Value: PartyCustomer, Resource: "salCustomers", LabelField: "name", Label: "客户"},
	{Value: PartyEmployee, Resource: "hrEmployees", LabelField: "name", Label: "员工"},
	{Value: PartySupplier, Resource: "purSuppliers", LabelField: "name", Label: "供应商"},
}

func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{
		VatInvoiceResourceMeta(),
		ExpenseReportResourceMeta(),
		ExpenseReportItemResourceMeta(),
		BillResourceMeta(),
		BillTransactionResourceMeta(),
		BillHoldingResourceMeta(),
	}
}

func VatInvoiceResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccVatInvoice"
	fields := []meta.FieldMeta{
		idMeta(),
		scalarMeta("doc_no", "docNo", meta.TypeString, "内部单据编号"),
		enumMeta("direction", "direction", "开票方向", []meta.EnumOption{
			{Value: DirectionInbound, Label: "开入"}, {Value: DirectionOutbound, Label: "开出"},
		}),
		scalarMeta("invoice_date", "invoiceDate", meta.TypeDate, "开票日期"),
		scalarMeta("posting_date", "postingDate", meta.TypeDate, "过账日期"),
		enumMeta("party_type", "partyType", "对手类型", partyOptions),
		polyMeta("party_id", "partyId", "对手"),
		enumMeta("invoice_kind", "invoiceKind", "发票种类", []meta.EnumOption{
			{Value: InvoiceSpecial, Label: "增值税专用发票"},
			{Value: InvoiceNormal, Label: "增值税普通发票"},
			{Value: InvoiceElectronicSpecial, Label: "电子专用发票"},
			{Value: InvoiceElectronicNormal, Label: "电子普通发票"},
			{Value: InvoiceDigitalSpecial, Label: "数电专票"},
			{Value: InvoiceDigitalNormal, Label: "数电普票"},
		}),
		scalarMeta("invoice_code", "invoiceCode", meta.TypeString, "发票代码(数电票为空串)"),
		scalarMeta("invoice_no", "invoiceNo", meta.TypeString, "发票号码"),
		scalarMeta("seller_name", "sellerName", meta.TypeString, "销方名称"),
		scalarMeta("seller_tax_no", "sellerTaxNo", meta.TypeString, "销方纳税人识别号"),
		scalarMeta("seller_address_phone", "sellerAddressPhone", meta.TypeString, "销方地址、电话"),
		scalarMeta("seller_bank_account", "sellerBankAccount", meta.TypeString, "销方开户行及账号"),
		scalarMeta("buyer_name", "buyerName", meta.TypeString, "购方名称"),
		scalarMeta("buyer_tax_no", "buyerTaxNo", meta.TypeString, "购方纳税人识别号"),
		scalarMeta("buyer_address_phone", "buyerAddressPhone", meta.TypeString, "购方地址、电话"),
		scalarMeta("buyer_bank_account", "buyerBankAccount", meta.TypeString, "购方开户行及账号"),
		readonlyMeta("items", "items", meta.TypeString, "发票明细", false, false),
		scalarMeta("net_total", "netTotal", meta.TypeDecimal, "不含税金额"),
		scalarMeta("tax_total", "taxTotal", meta.TypeDecimal, "税额"),
		scalarMeta("gross_total", "grossTotal", meta.TypeDecimal, "价税合计"),
		scalarMeta("issuer", "issuer", meta.TypeString, "开票人"),
		scalarMeta("reviewer", "reviewer", meta.TypeString, "复核人"),
		scalarMeta("payee", "payee", meta.TypeString, "收款人"),
		scalarMeta("remarks", "remarks", meta.TypeString, "备注"),
		scalarMeta("red_invoice_no", "redInvoiceNo", meta.TypeString, "红冲对应原发票号码"),
		enumMeta("status", "status", "状态", []meta.EnumOption{
			{Value: StatusDraft, Label: "草稿"}, {Value: StatusAudited, Label: "已审核"},
			{Value: StatusVoided, Label: "已作废"}, {Value: StatusReversed, Label: "已红冲"},
		}),
		scalarMeta("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
		scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		scalarMeta("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
		refMeta("company_id", "companyId", "公司", "basCompanies", "company", "name"),
		refMeta("party_account_id", "partyAccountId", "往来科目", "basAccounts", "partyAccount", "name"),
		refMeta("amount_account_id", "amountAccountId", "金额科目", "basAccounts", "amountAccount", "name"),
		refMeta("tax_account_id", "taxAccountId", "税额科目", "basAccounts", "taxAccount", "name"),
		refMeta("mirror_invoice_id", "mirrorInvoiceId", "对向发票", "accVatInvoices", "mirrorInvoice", "docNo"),
		refMeta("sal_reconciliation_id", "salReconciliationId",
			"关联销售对账单(仅开出发票、草稿可改;审核一对一结单)",
			"salReconciliations", "salReconciliation", "reconciliationNo"),
		refMeta("pur_reconciliation_id", "purReconciliationId",
			"关联采购对账单(仅开入发票、对手非员工时草稿必填;审核一对一结单)",
			"purReconciliations", "purReconciliation", "reconciliationNo"),
		refMeta("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
		refMeta("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
	}
	return meta.ResourceMeta{
		Name: "accVatInvoices", PermissionPrefix: "acc.vat_invoice",
		PermissionLabel: "增值税发票", Table: "acc_vat_invoice", Fields: fields,
		Actions: []meta.ActionMeta{
			action("read", "查看", "both", "", false),
			action("create", "新增", "both", "", false),
			action("update", "编辑", "row", "", false),
			action("delete", "删除", "row", "", true),
			action("audit", "审核", "row", "auditAccVatInvoice", false),
			action("void", "作废", "row", "voidAccVatInvoice", true),
			action("reverse", "红冲", "row", "reverseAccVatInvoice", true),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ExpenseReportResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccExpenseReport"
	return meta.ResourceMeta{
		Name: "accExpenseReports", PermissionPrefix: "acc.expense_report",
		PermissionLabel: "费用报销单", Table: "acc_expense_report",
		Fields: []meta.FieldMeta{
			idMeta(),
			scalarMeta("doc_no", "docNo", meta.TypeString, "单据编号(留空自动取号)"),
			scalarMeta("expense_date", "expenseDate", meta.TypeDate, "报销日期"),
			scalarMeta("posting_date", "postingDate", meta.TypeDate, "过账日期"),
			scalarMeta("remarks", "remarks", meta.TypeString, "备注"),
			enumMeta("status", "status", "状态", []meta.EnumOption{
				{Value: StatusDraft, Label: "草稿"}, {Value: StatusAudited, Label: "已审核"},
				{Value: StatusVoided, Label: "已作废"},
			}),
			scalarMeta("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
			scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			scalarMeta("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refMeta("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refMeta("employee_id", "employeeId", "员工(报销对象)", "hrEmployees", "employee", "name"),
			refMeta("payment_account_id", "paymentAccountId",
				"付款科目(贷方,银行存款/库存现金类;草稿必填)",
				"basAccounts", "paymentAccount", "name"),
			refMeta("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
			refMeta("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
		},
		Actions: []meta.ActionMeta{
			action("read", "查看", "both", "", false),
			action("create", "新增", "both", "", false),
			action("update", "编辑", "row", "", false),
			action("delete", "删除", "row", "", true),
			action("audit", "审核", "row", "auditAccExpenseReport", false),
			action("void", "作废", "row", "voidAccExpenseReport", true),
		},
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "items", Resource: "accExpenseReportItems"}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func ExpenseReportItemResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccExpenseReportItem"
	return meta.ResourceMeta{
		Name: "accExpenseReportItems", PermissionPrefix: "acc.expense_report",
		PermissionLabel: "费用报销单", Table: "acc_expense_report_item",
		Fields: []meta.FieldMeta{
			idMeta(),
			scalarMeta("idx", "idx", meta.TypeInteger, "行号"),
			enumMeta("kind", "kind", "行类型(挂票/无票)", []meta.EnumOption{
				{Value: ExpenseInvoiced, Label: "挂票"}, {Value: ExpenseManual, Label: "无票"},
			}),
			scalarMeta("summary", "summary", meta.TypeString, "摘要(无票行必填)"),
			scalarMeta("amount", "amount", meta.TypeDecimal,
				"金额(无票行必填;挂票行金额取发票价税合计,不冗余存储)"),
			scalarMeta("remarks", "remarks", meta.TypeString, "行备注"),
			scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			scalarMeta("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refMeta("report_id", "reportId", "报销单", "accExpenseReports", "report", "docNo"),
			refMeta("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refMeta("invoice_id", "invoiceId", "挂票发票(挂票行必填)", "accVatInvoices", "invoice", "docNo"),
			refMeta("expense_account_id", "expenseAccountId", "费用科目(无票行必填)",
				"basAccounts", "expenseAccount", "name"),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BillResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBill"
	return meta.ResourceMeta{
		Name: "accBills", PermissionPrefix: "acc.bill", PermissionLabel: "承兑票据",
		Table: "acc_bill",
		Fields: append([]meta.FieldMeta{
			idMeta(),
			scalarMeta("bill_no", "billNo", meta.TypeString, "票据号码"),
			enumMeta("bill_kind", "billKind", "票据种类", []meta.EnumOption{
				{Value: BillBankAcceptance, Label: "银行承兑汇票"},
				{Value: BillCommercialAcceptance, Label: "商业承兑汇票"},
				{Value: BillFinanceCompanyAcceptance, Label: "财务公司承兑汇票"},
			}),
			scalarMeta("issue_date", "issueDate", meta.TypeDate, "出票日期"),
			scalarMeta("due_date", "dueDate", meta.TypeDate, "到期日"),
			scalarMeta("face_amount", "faceAmount", meta.TypeDecimal, "票据包金额"),
		}, billPartyFields()...),
		Actions: []meta.ActionMeta{
			action("read", "查看", "both", "", false),
			action("update", "编辑", "row", "", false),
			action("delete", "删除", "row", "", true),
		},
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "transactions", Resource: "accBillTransactions"}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func billPartyFields() []meta.FieldMeta {
	return []meta.FieldMeta{
		scalarMeta("drawer_name", "drawerName", meta.TypeString, "出票人名称"),
		scalarMeta("drawer_account", "drawerAccount", meta.TypeString, "出票人账号"),
		scalarMeta("drawer_bank_name", "drawerBankName", meta.TypeString, "出票人开户行"),
		scalarMeta("drawer_bank_no", "drawerBankNo", meta.TypeString, "出票人开户行联行号"),
		scalarMeta("payee_name", "payeeName", meta.TypeString, "收款人名称"),
		scalarMeta("payee_account", "payeeAccount", meta.TypeString, "收款人账号"),
		scalarMeta("payee_bank_name", "payeeBankName", meta.TypeString, "收款人开户行"),
		scalarMeta("payee_bank_no", "payeeBankNo", meta.TypeString, "收款人开户行联行号"),
		scalarMeta("acceptor_name", "acceptorName", meta.TypeString, "承兑人名称"),
		scalarMeta("acceptor_account", "acceptorAccount", meta.TypeString, "承兑人账号"),
		scalarMeta("acceptor_bank_name", "acceptorBankName", meta.TypeString, "承兑人开户行"),
		scalarMeta("acceptor_bank_no", "acceptorBankNo", meta.TypeString, "承兑人开户行联行号"),
		scalarMeta("transferable", "transferable", meta.TypeBoolean, "能否转让"),
		scalarMeta("acceptance_date", "acceptanceDate", meta.TypeDate, "承兑日期"),
		scalarMeta("remarks", "remarks", meta.TypeString, "备注"),
		scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
		scalarMeta("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
	}
}

func BillTransactionResourceMeta() meta.ResourceMeta {
	destroy := "destroyAccBillTransaction"
	return meta.ResourceMeta{
		Name: "accBillTransactions", PermissionPrefix: "acc.bill_transaction",
		PermissionLabel: "承兑交易", Table: "acc_bill_transaction",
		Fields: []meta.FieldMeta{
			idMeta(),
			scalarMeta("doc_no", "docNo", meta.TypeString, "单据编号"),
			enumMeta("transaction_type", "transactionType", "交易类型", []meta.EnumOption{
				{Value: TransactionReceive, Label: "接收"}, {Value: TransactionEndorse, Label: "转让"},
				{Value: TransactionSettle, Label: "兑付"}, {Value: TransactionDiscount, Label: "贴现"},
				{Value: TransactionReallocate, Label: "调拨"},
			}),
			scalarMeta("occurred_on", "occurredOn", meta.TypeDate, "发生日期"),
			scalarMeta("sub_start", "subStart", meta.TypeInteger, "子票起"),
			scalarMeta("sub_end", "subEnd", meta.TypeInteger, "子票止"),
			scalarMeta("amount", "amount", meta.TypeDecimal, "交易金额(段金额)"),
			enumMeta("party_type", "partyType", "对手类型", partyOptions),
			polyMeta("party_id", "partyId", "交易对手"),
			scalarMeta("discount_org", "discountOrg", meta.TypeString, "贴现机构"),
			scalarMeta("discount_rate", "discountRate", meta.TypeDecimal, "贴现利率(年化%)"),
			scalarMeta("interest", "interest", meta.TypeDecimal, "贴现利息"),
			scalarMeta("net_amount", "netAmount", meta.TypeDecimal, "实收金额"),
			scalarMeta("posting_date", "postingDate", meta.TypeDate, "过账日期"),
			enumMeta("status", "status", "状态", []meta.EnumOption{
				{Value: StatusDraft, Label: "草稿"}, {Value: StatusAudited, Label: "已审核"},
				{Value: StatusVoided, Label: "已作废"},
			}),
			scalarMeta("audited_at", "auditedAt", meta.TypeDatetime, "审核时间"),
			scalarMeta("remarks", "remarks", meta.TypeString, "备注"),
			scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			scalarMeta("updated_at", "updatedAt", meta.TypeDatetime, "更新时间"),
			refMeta("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refMeta("bank_account_id", "bankAccountId", "本方银行账户(调拨为转出账户)",
				"accBankAccounts", "bankAccount", "alias"),
			refMeta("to_bank_account_id", "toBankAccountId", "调拨转入账户",
				"accBankAccounts", "toBankAccount", "alias"),
			refMeta("bill_id", "billId", "关联票据", "accBills", "bill", "billNo"),
			refMeta("bill_account_id", "billAccountId", "票据科目", "basAccounts", "billAccount", "name"),
			refMeta("settle_account_id", "settleAccountId", "结算科目", "basAccounts", "settleAccount", "name"),
			refMeta("interest_account_id", "interestAccountId", "利息科目", "basAccounts", "interestAccount", "name"),
			refMeta("created_by_id", "createdById", "录入人", "sysUsers", "createdBy", "name"),
			refMeta("audited_by_id", "auditedById", "审核人", "sysUsers", "auditedBy", "name"),
		},
		Actions: []meta.ActionMeta{
			action("read", "查看", "both", "", false),
			action("create", "新增", "both", "", false),
			action("update", "编辑", "row", "", false),
			action("delete", "删除", "row", "", true),
			action("audit", "审核", "row", "auditAccBillTransaction", false),
			action("void", "作废", "row", "voidAccBillTransaction", true),
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func BillHoldingResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: "accBillHoldings", PermissionPrefix: "acc.bill_holding",
		PermissionLabel: "持有承兑", Table: "acc_bill_holding",
		Fields: []meta.FieldMeta{
			idMeta(),
			scalarMeta("bill_no", "billNo", meta.TypeString, "票据号码(冗余自票据主档)"),
			scalarMeta("sub_start", "subStart", meta.TypeInteger, "子票起"),
			scalarMeta("sub_end", "subEnd", meta.TypeInteger, "子票止"),
			scalarMeta("amount", "amount", meta.TypeDecimal, "持有金额"),
			scalarMeta("due_date", "dueDate", meta.TypeDate, "到期日(冗余自票据主档)"),
			scalarMeta("acquired_on", "acquiredOn", meta.TypeDate, "取得日期"),
			// 旧打印目录的展示标签（Elixir 计算字段），仅打印可见
			{Name: "label", APIName: "label", DBColumn: "label", Type: meta.TypeString,
				Label: "展示标签", Calculated: true, PrintOnly: true},
			scalarMeta("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间"),
			refMeta("company_id", "companyId", "公司", "basCompanies", "company", "name"),
			refMeta("bank_account_id", "bankAccountId", "持有银行账户",
				"accBankAccounts", "bankAccount", "alias"),
			refMeta("bill_id", "billId", "关联票据", "accBills", "bill", "billNo"),
			refMeta("source_transaction_id", "sourceTransactionId",
				"来源交易(该段最近一次取得的交易)",
				"accBillTransactions", "sourceTransaction", "docNo"),
		},
		Actions: []meta.ActionMeta{action("read", "查看", "both", "", false)},
	}
}

func idMeta() meta.FieldMeta {
	return meta.FieldMeta{
		Name: "id", APIName: "id", DBColumn: "id", Type: meta.TypeUUID,
		Label: "id", Readonly: true, Sortable: true,
	}
}

func scalarMeta(name, api string, kind meta.FieldType, label string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: kind, Label: label,
		Filterable: true, Sortable: true,
	}
}

func readonlyMeta(
	name, api string, kind meta.FieldType, label string, filterable, sortable bool,
) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: kind, Label: label,
		Readonly: true, Filterable: filterable, Sortable: sortable,
	}
}

func enumMeta(name, api, label string, options []meta.EnumOption) meta.FieldMeta {
	field := scalarMeta(name, api, meta.TypeEnum, label)
	field.EnumOptions = options
	return field
}

func refMeta(name, api, label, resource, relation, labelField string) meta.FieldMeta {
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: meta.TypeFK,
		Label: label, Filterable: true,
		Ref: &meta.GridColumnRef{
			Resource: &resource, Relation: &relation, LabelField: &labelField,
		},
	}
}

func polyMeta(name, api, label string) meta.FieldMeta {
	discriminator, discriminatorType := "partyType", "enum"
	return meta.FieldMeta{
		Name: name, APIName: api, DBColumn: name, Type: meta.TypeFK,
		Label: label, Filterable: true,
		Ref: &meta.GridColumnRef{
			Discriminator: &discriminator, DiscriminatorType: &discriminatorType,
			Variants: partyVariants,
		},
	}
}

func action(key, label, scope, mutation string, danger bool) meta.ActionMeta {
	return meta.ActionMeta{
		Key: key, Label: label, Scope: scope, Mutation: mutation, IsDanger: danger,
	}
}
