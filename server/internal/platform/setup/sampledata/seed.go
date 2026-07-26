// Package sampledata 实现初始化向导可选的全业务链示例数据。
// 编排与字段口径对齐 Elixir SynieCore.Setup.SampleData。
package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/hr/operations"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// Dependencies 持有示例种子所需领域服务。各服务自开事务;完成旗标由 setup.Complete 在 Seed 成功后写入。
type Dependencies struct {
	Pool                   *pgxpool.Pool
	Accounts               *account.Service
	CompanyAccountDefaults *companyaccountdefault.Service
	Warehouses             *warehouse.Service
	Customers              *customer.Service
	Suppliers              *supplier.Service
	Materials              *material.Service
	MaterialUnits          *materialunit.Service
	Employees              *employee.Service
	Quotations             *quotation.Service
	Orders                 *order.Service
	StandardFulfillment    *standard.Service
	OutsourcedFulfillment  *outsourced.Service
	Reconciliations        *reconciliation.Service
	StockDocs              *stockdoc.Service
	StockTransfers         *stocktransfer.Service
	StockCounts            *stockcount.Service
	ManufacturingMaster    *master.Service
	Banking                *banking.Service
	GLJournals             *gljournal.Service
	Documents              *documents.Service
	HROperations           *operations.Service
}

// Summary 与 Elixir 摘要键对齐;已种子跳过时各计数为 0。
type Summary struct {
	Customers               int `json:"customers"`
	Suppliers               int `json:"suppliers"`
	Materials               int `json:"materials"`
	Employees               int `json:"employees"`
	SalesQuotations         int `json:"salesQuotations"`
	PurchaseQuotations      int `json:"purchaseQuotations"`
	SalesOrders             int `json:"salesOrders"`
	PurchaseOrders          int `json:"purchaseOrders"`
	SalesDeliveries         int `json:"salesDeliveries"`
	PurchaseReceipts        int `json:"purchaseReceipts"`
	SalesReconciliations    int `json:"salesReconciliations"`
	PurchaseReconciliations int `json:"purchaseReconciliations"`
	StockDocs               int `json:"stockDocs"`
	StockTransfers          int `json:"stockTransfers"`
	StockCounts             int `json:"stockCounts"`
	Operations              int `json:"operations"`
	ProcessTemplates        int `json:"processTemplates"`
	BOMs                    int `json:"boms"`
	BankAccounts            int `json:"bankAccounts"`
	BankTransactions        int `json:"bankTransactions"`
	GLJournals              int `json:"glJournals"`
	ExpenseReports          int `json:"expenseReports"`
	Payrolls                int `json:"payrolls"`
	VatInvoices             int `json:"vatInvoices"`
	OutsourcedOrders        int `json:"outsourcedOrders"`
	OutsourcedIssues        int `json:"outsourcedIssues"`
	OutsourcedReceipts      int `json:"outsourcedReceipts"`
}

type companyInfo struct {
	ID             uuid.UUID
	Code           string
	Name           string
	ShortName      string
	BaseCurrencyID uuid.UUID
}

type accounts struct {
	UnbilledAR uuid.UUID
	UnbilledAP uuid.UUID
	Revenue    uuid.UUID
	Inventory  uuid.UUID
	Bank       uuid.UUID
	Capital    uuid.UUID
	Expense    uuid.UUID
	Receivable uuid.UUID
	Payable    uuid.UUID
	Tax        uuid.UUID
}

type warehouses struct {
	Default  uuid.UUID
	Transit  uuid.UUID
	Finished uuid.UUID
	Root     uuid.UUID
}

type seedCtx struct {
	Company    companyInfo
	Accounts   accounts
	Warehouses warehouses
}

type materialRef struct {
	ID            uuid.UUID
	DefaultUnitID uuid.UUID
}

type masterData struct {
	Company   companyInfo
	Customers map[string]customer.Customer
	Suppliers map[string]supplier.Supplier
	Materials map[string]materialRef
	Employees map[string]employee.Employee
}

type chainDoc struct {
	ID    uuid.UUID
	Items map[int]uuid.UUID
}

type purchaseResult struct {
	Quotations               []uuid.UUID
	Orders                   []uuid.UUID
	Receipts                 []uuid.UUID
	Reconciliations          []uuid.UUID
	ConfirmedReconciliation  uuid.UUID
	ConfirmedBaseGrossTotal  string
	QuotationItems           map[string]map[string]uuid.UUID // qKey -> matKey -> itemID
	OrderItems               map[string]map[int]uuid.UUID
	ReceiptItems             map[string]map[int]uuid.UUID
}

type salesResult struct {
	Quotations              []uuid.UUID
	Orders                  []uuid.UUID
	Deliveries              []uuid.UUID
	Reconciliations         []uuid.UUID
	ConfirmedReconciliation uuid.UUID
	ConfirmedBaseGrossTotal string
	QuotationItems          map[string]map[string]uuid.UUID
	OrderItems              map[string]map[int]uuid.UUID
	DeliveryItems           map[string]map[int]uuid.UUID
}

type invDocsResult struct {
	StockDocs int
}

type mfgResult struct {
	Operations       []uuid.UUID
	ProcessTemplates []uuid.UUID
	BOMs             []uuid.UUID
	OpsByName        map[string]uuid.UUID
}

type outsourcedResult struct {
	BOMs            []uuid.UUID
	Orders          []uuid.UUID
	Issues          []uuid.UUID
	Receipts        []uuid.UUID
	Reconciliations []uuid.UUID
}

type financeResult struct {
	BankTransactions int
	GLJournals       int
	Payrolls         int
	VatInvoices      int
}

// Seed 为指定公司写入示例业务数据。
// 整组成功标记为示例银行账号;中途失败留下半成品时返回明确错误,要求空库重跑而非静默跳过。
func Seed(ctx context.Context, deps Dependencies, actor *authz.Actor, companyID uuid.UUID) (Summary, error) {
	if deps.Pool == nil {
		return Summary{}, apierror.New(apierror.CodeInternal, "示例数据依赖未配置")
	}
	seeded, err := alreadySeeded(ctx, deps.Pool)
	if err != nil {
		return Summary{}, err
	}
	if seeded {
		return Summary{}, nil
	}
	partial, err := partialSampleStarted(ctx, deps.Pool)
	if err != nil {
		return Summary{}, err
	}
	if partial {
		// 中途失败留下半成品(如缺编号规则导致 BOM 建不出来);清掉后整组重跑。
		if err := wipePartialSample(ctx, deps.Pool); err != nil {
			return Summary{}, err
		}
	}
	if companyID == uuid.Nil {
		return Summary{}, nil
	}
	company, err := loadCompany(ctx, deps.Pool, companyID)
	if err != nil {
		return Summary{}, err
	}

	seedContext, err := seedPrerequisites(ctx, deps, actor, company)
	if err != nil {
		return Summary{}, err
	}
	md, err := seedMaster(ctx, deps, actor, company)
	if err != nil {
		return Summary{}, err
	}
	openingDocs, err := seedOpeningStock(ctx, deps, actor, seedContext, md)
	if err != nil {
		return Summary{}, err
	}
	purchase, err := seedPurchase(ctx, deps, actor, seedContext, md)
	if err != nil {
		return Summary{}, err
	}
	sales, err := seedSales(ctx, deps, actor, seedContext, md)
	if err != nil {
		return Summary{}, err
	}
	invDocs, err := seedInventoryDocuments(ctx, deps, actor, seedContext, md)
	if err != nil {
		return Summary{}, err
	}
	mfg, err := seedMfg(ctx, deps, actor, md)
	if err != nil {
		return Summary{}, err
	}
	out, err := seedOutsourced(ctx, deps, actor, seedContext, md)
	if err != nil {
		return Summary{}, err
	}
	finance, err := seedFinance(ctx, deps, actor, seedContext, md, sales, purchase)
	if err != nil {
		return Summary{}, err
	}

	return Summary{
		Customers:               len(md.Customers),
		Suppliers:               len(md.Suppliers),
		Materials:               len(md.Materials),
		Employees:               len(md.Employees),
		SalesQuotations:         len(sales.Quotations),
		PurchaseQuotations:      len(purchase.Quotations),
		SalesOrders:             len(sales.Orders),
		PurchaseOrders:          len(purchase.Orders),
		SalesDeliveries:         len(sales.Deliveries),
		PurchaseReceipts:        len(purchase.Receipts),
		SalesReconciliations:    len(sales.Reconciliations),
		PurchaseReconciliations: len(purchase.Reconciliations) + len(out.Reconciliations),
		StockDocs:               openingDocs + invDocs.StockDocs,
		StockTransfers:          1,
		StockCounts:             1,
		Operations:              len(mfg.Operations),
		ProcessTemplates:        len(mfg.ProcessTemplates),
		BOMs:                    len(mfg.BOMs) + len(out.BOMs),
		BankAccounts:            1,
		BankTransactions:        finance.BankTransactions,
		GLJournals:              finance.GLJournals,
		ExpenseReports:          1,
		Payrolls:                finance.Payrolls,
		VatInvoices:             finance.VatInvoices,
		OutsourcedOrders:        len(out.Orders),
		OutsourcedIssues:        len(out.Issues),
		OutsourcedReceipts:      len(out.Receipts),
	}, nil
}
