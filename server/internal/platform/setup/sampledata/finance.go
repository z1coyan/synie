package sampledata

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/domain/hr/operations"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedFinance(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
	sales salesResult, purchase purchaseResult,
) (financeResult, error) {
	bankAccount, err := deps.Banking.CreateBankAccount(ctx, actor, banking.BankAccountCreateInput{
		Alias: "基本户", BankName: "中国银行", BranchName: ptr("台州分行营业部"),
		HolderName: sc.Company.Name, AccountNo: "377601886688901",
		CompanyID: sc.Company.ID, CurrencyID: sc.Company.BaseCurrencyID, AccountID: &sc.Accounts.Bank,
	})
	if err != nil {
		return financeResult{}, err
	}

	type txSpec struct {
		ago, hour                      int
		income, expense                *string
		balance, counterparty, summary string
	}
	c01, c02 := md.Customers["C01"], md.Customers["C02"]
	s01, s04 := md.Suppliers["S01"], md.Suppliers["S04"]
	txSpecs := []txSpec{
		{80, 10, ptr("200000.00"), nil, "200000.00", "王建国", "股东注资款"},
		{28, 14, ptr("36000.00"), nil, "236000.00", c01.Name, "海纳电气货款"},
		{20, 9, nil, ptr("33360.00"), "202640.00", s01.Name, "支付精铜材料货款"},
		{15, 16, nil, ptr("8500.00"), "194140.00", s04.Name, "支付恒力钣金部分货款"},
		{8, 11, ptr("12500.00"), nil, "206640.00", c02.Name, "联成机电预付款"},
		{5, 15, nil, ptr("3200.00"), "203440.00", "陈晓梅", "报销及办公用品采购"},
	}
	txCount := 0
	for _, spec := range txSpecs {
		occurred := daysAgo(spec.ago).Add(time.Duration(spec.hour) * time.Hour)
		input := banking.BankTransactionCreateInput{
			OccurredAt: occurred, Balance: ptr(dec(spec.balance)),
			CounterpartyName: ptr(spec.counterparty), Summary: ptr(spec.summary),
			CompanyID: sc.Company.ID, BankAccountID: bankAccount.ID,
		}
		if spec.income != nil {
			input.Income = ptr(dec(*spec.income))
		}
		if spec.expense != nil {
			input.Expense = ptr(dec(*spec.expense))
		}
		if _, err := deps.Banking.CreateBankTransaction(ctx, actor, input); err != nil {
			return financeResult{}, err
		}
		txCount++
	}

	if err := createGLJournal(ctx, deps, actor, sc, 85, "期初实收资本入账",
		[]glLine{
			{sc.Accounts.Bank, "200000.00", "0"},
			{sc.Accounts.Capital, "0", "200000.00"},
		}); err != nil {
		return financeResult{}, err
	}
	if err := createGLJournal(ctx, deps, actor, sc, 30, "支付当月办公场地租金",
		[]glLine{
			{sc.Accounts.Expense, "1200.00", "0"},
			{sc.Accounts.Bank, "0", "1200.00"},
		}); err != nil {
		return financeResult{}, err
	}

	date := daysAgo(18)
	report, err := deps.Documents.CreateExpenseReport(ctx, actor, documents.ExpenseReportInput{
		CompanyID: sc.Company.ID, ExpenseDate: dateString(date), PostingDate: ptr(dateString(date)),
		EmployeeID: md.Employees["陈晓梅"].ID, PaymentAccountID: sc.Accounts.Bank,
		Remarks: ptr("初始化示例报销单"),
	})
	if err != nil {
		return financeResult{}, err
	}
	for i, line := range []struct {
		summary string
		amount  string
	}{
		{"宁波客户拜访差旅费", "860.00"},
		{"办公用品采购", "240.50"},
	} {
		if _, err := deps.Documents.CreateExpenseReportItem(ctx, actor, documents.ExpenseReportItemInput{
			ReportID: report.ID, Idx: int64(i + 1), Kind: documents.ExpenseManual,
			Summary: ptr(line.summary), Amount: ptr(line.amount), ExpenseAccountID: &sc.Accounts.Expense,
		}); err != nil {
			return financeResult{}, err
		}
	}
	if _, err := deps.Documents.AuditExpenseReport(ctx, actor, report.ID, dateString(date)); err != nil {
		return financeResult{}, err
	}

	month := previousMonth()
	p1, err := deps.HROperations.CreatePayroll(ctx, actor, operations.PayrollInput{
		EmployeeID: md.Employees["张伟强"].ID, Month: month,
		Workdays: "22", AttendanceDays: 22, MissingDays: 0, OvertimeHours: "0",
		DailyWage: "260", Allowance: "300", Bonus: "500", Fine: "0", LoanDeduction: "0",
		Remarks: ptr("初始化示例工资单"),
	})
	if err != nil {
		return financeResult{}, err
	}
	if _, err := deps.HROperations.CreatePayrollPayment(ctx, actor, operations.PayrollPaymentInput{
		PayrollID: p1.ID, PaidOn: dateString(daysAgo(10)), Amount: "6520.00", Remarks: ptr("银行代发"),
	}); err != nil {
		return financeResult{}, err
	}
	if _, err := deps.HROperations.CreatePayroll(ctx, actor, operations.PayrollInput{
		EmployeeID: md.Employees["李秀英"].ID, Month: month,
		Workdays: "21", AttendanceDays: 21, MissingDays: 0, OvertimeHours: "0",
		DailyWage: "220", Allowance: "300", Bonus: "0", Fine: "0", LoanDeduction: "0",
		Remarks: ptr("初始化示例工资单(待发放)"),
	}); err != nil {
		return financeResult{}, err
	}

	if err := createVatInvoice(ctx, deps, actor, sc, documents.DirectionOutbound, 15,
		"customer", c01.ID, "033002400116", "04632188",
		sc.Company.Name, c01.Name, sales.ConfirmedBaseGrossTotal,
		sc.Accounts.Receivable, sc.Accounts.Revenue, sc.Accounts.Tax,
		&sales.ConfirmedReconciliation, nil,
		[]invoiceLine{
			{"配电箱壳体", "HN-BX-100 定制", "件", "50", "128.00"},
			{"汇流铜排组件", "HN-BB-08 8 路", "件", "20", "86.50"},
		}, "初始化示例销项发票"); err != nil {
		return financeResult{}, err
	}
	if err := createVatInvoice(ctx, deps, actor, sc, documents.DirectionInbound, 10,
		"supplier", s01.ID, "033002400205", "55209317",
		s01.Name, sc.Company.Name, purchase.ConfirmedBaseGrossTotal,
		sc.Accounts.Payable, sc.Accounts.Inventory, sc.Accounts.Tax,
		nil, &purchase.ConfirmedReconciliation,
		[]invoiceLine{
			{"紫铜棒", "T2 φ20", "件", "500", "52.00"},
			{"紫铜排", "T2 3×30×1000", "件", "200", "36.80"},
		}, "初始化示例进项发票"); err != nil {
		return financeResult{}, err
	}

	return financeResult{
		BankTransactions: txCount, GLJournals: 2, Payrolls: 2, VatInvoices: 2,
	}, nil
}

type glLine struct {
	accountID     uuid.UUID
	debit, credit string
}

func createGLJournal(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	dateAgo int, remarks string, lines []glLine,
) error {
	date := daysAgo(dateAgo)
	journal, err := deps.GLJournals.Create(ctx, actor, gljournal.CreateInput{
		Date: date, PostingDate: &date, Remarks: ptr(remarks), CompanyID: sc.Company.ID,
	})
	if err != nil {
		return err
	}
	for i, line := range lines {
		if _, err := deps.GLJournals.CreateLine(ctx, actor, gljournal.CreateLineInput{
			JournalID: journal.ID, Idx: int64(i + 1), AccountID: line.accountID,
			Debit: dec(line.debit), Credit: dec(line.credit),
		}); err != nil {
			return err
		}
	}
	_, err = deps.GLJournals.Audit(ctx, actor, journal.ID, nil)
	return err
}

type invoiceLine struct {
	name, model, unit, qty, price string
}

func createVatInvoice(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	direction string, dateAgo int, partyType string, partyID uuid.UUID,
	invoiceCode, invoiceNo, seller, buyer, gross string,
	partyAccount, amountAccount, taxAccount uuid.UUID,
	salRecon, purRecon *uuid.UUID,
	lines []invoiceLine, remarks string,
) error {
	grossDec := dec(gross)
	net, tax := splitVAT(grossDec)
	items := make([]map[string]string, 0, len(lines))
	for _, line := range lines {
		lineGross := dec(line.qty).Mul(dec(line.price)).Round(2)
		lineNet, lineTax := splitVAT(lineGross)
		items = append(items, map[string]string{
			"name": line.name, "model": line.model, "unit": line.unit,
			"quantity": line.qty, "price": line.price,
			"net_amount": lineNet.StringFixed(2), "tax_rate": "13%",
			"tax_amount": lineTax.StringFixed(2),
		})
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return err
	}
	date := dateString(daysAgo(dateAgo))
	input := documents.VatInvoiceInput{
		CompanyID: sc.Company.ID, Direction: direction, InvoiceDate: &date,
		PartyType: partyType, PartyID: partyID, InvoiceKind: documents.InvoiceSpecial,
		InvoiceCode: invoiceCode, InvoiceNo: &invoiceNo,
		SellerName: &seller, BuyerName: &buyer, Items: string(itemsJSON),
		NetTotal: ptr(net.StringFixed(2)), TaxTotal: ptr(tax.StringFixed(2)), GrossTotal: ptr(gross),
		PartyAccountID: &partyAccount, AmountAccountID: &amountAccount, TaxAccountID: &taxAccount,
		SalesReconciliationID: salRecon, PurchaseReconciliationID: purRecon, Remarks: ptr(remarks),
	}
	invoice, err := deps.Documents.CreateVatInvoice(ctx, actor, input)
	if err != nil {
		return err
	}
	_, err = deps.Documents.AuditVatInvoice(ctx, actor, invoice.ID, date)
	return err
}

func splitVAT(gross decimal.Decimal) (net, tax decimal.Decimal) {
	rate := dec("0.13")
	net = gross.Div(decimal.NewFromInt(1).Add(rate)).Round(2)
	tax = gross.Sub(net)
	return net, tax
}

func previousMonth() string {
	now := time.Now().UTC()
	first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	prev := first.AddDate(0, 0, -1)
	return fmt.Sprintf("%04d-%02d", prev.Year(), int(prev.Month()))
}
