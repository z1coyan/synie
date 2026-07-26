package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/z1coyan/synie/server/internal/db"
	"github.com/z1coyan/synie/server/internal/domain/accounting/glentry"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/base/currency"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	hroperations "github.com/z1coyan/synie/server/internal/domain/hr/operations"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/execution"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/scm/orderflow"
	"github.com/z1coyan/synie/server/internal/domain/systemops"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	httpapi "github.com/z1coyan/synie/server/internal/http"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/config"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/iam"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/printing"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Synie Go 服务退出", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("加载配置: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Open(rootCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	registry := meta.NewRegistry()
	registry.MustRegister(glentry.ResourceMeta())
	registry.MustRegister(gljournal.ResourceMeta())
	registry.MustRegister(gljournal.LineResourceMeta())
	registry.MustRegister(currency.ResourceMeta())
	registry.MustRegister(company.ResourceMeta())
	registry.MustRegister(unit.ResourceMeta())
	for _, resource := range market.ResourceMetas() {
		registry.MustRegister(resource)
	}
	registry.MustRegister(account.ResourceMeta())
	registry.MustRegister(customer.ResourceMeta())
	registry.MustRegister(supplier.ResourceMeta())
	registry.MustRegister(employee.ResourceMeta())
	for _, resource := range hroperations.ResourceMetas() {
		registry.MustRegister(resource)
	}
	for _, resource := range banking.ResourceMetas() {
		registry.MustRegister(resource)
	}
	for _, resource := range documents.ResourceMetas() {
		registry.MustRegister(resource)
	}
	registry.MustRegister(materialcategory.ResourceMeta())
	registry.MustRegister(material.ResourceMeta())
	registry.MustRegister(materialunit.ResourceMeta())
	registry.MustRegister(warehouse.ResourceMeta())
	registry.MustRegister(stockentry.ResourceMeta())
	registry.MustRegister(stockdoc.ResourceMeta())
	registry.MustRegister(stockdoc.ItemResourceMeta())
	registry.MustRegister(stocktransfer.ResourceMeta())
	registry.MustRegister(stocktransfer.ItemResourceMeta())
	registry.MustRegister(stockcount.ResourceMeta())
	registry.MustRegister(stockcount.ItemResourceMeta())
	for _, side := range []quotation.Side{quotation.SideSales, quotation.SidePurchase} {
		registry.MustRegister(quotation.QuotationResourceMeta(side))
		registry.MustRegister(quotation.ItemResourceMeta(side))
		registry.MustRegister(quotation.TierResourceMeta(side))
	}
	for _, side := range []order.Side{order.SideSales, order.SidePurchase} {
		registry.MustRegister(order.OrderResourceMeta(side))
		registry.MustRegister(order.ItemResourceMeta(side))
	}
	registry.MustRegister(order.MaterialResourceMeta())
	registry.MustRegister(order.ByproductResourceMeta())
	registry.MustRegister(master.OperationResourceMeta())
	registry.MustRegister(master.TemplateResourceMeta())
	registry.MustRegister(master.TemplateItemResourceMeta())
	registry.MustRegister(master.BOMResourceMeta())
	registry.MustRegister(master.ComponentResourceMeta())
	registry.MustRegister(master.RouteResourceMeta())
	registry.MustRegister(master.ByproductResourceMeta())
	registry.MustRegister(execution.DemandResourceMeta())
	registry.MustRegister(execution.DemandItemResourceMeta())
	registry.MustRegister(execution.WorkOrderResourceMeta())
	registry.MustRegister(execution.OutputResourceMeta())
	registry.MustRegister(execution.OutputItemResourceMeta())
	for _, side := range []standard.Side{standard.SideSales, standard.SidePurchase} {
		registry.MustRegister(standard.HeadResourceMeta(side))
		registry.MustRegister(standard.ItemResourceMeta(side))
	}
	registry.MustRegister(outsourced.IssueResourceMeta())
	registry.MustRegister(outsourced.IssueItemResourceMeta())
	registry.MustRegister(outsourced.ReceiptResourceMeta())
	registry.MustRegister(outsourced.ReceiptItemResourceMeta())
	registry.MustRegister(outsourced.ReceiptMaterialResourceMeta())
	registry.MustRegister(outsourced.ReceiptByproductResourceMeta())
	for _, side := range []reconciliation.Side{
		reconciliation.SideSales,
		reconciliation.SidePurchase,
	} {
		registry.MustRegister(reconciliation.HeadResourceMeta(side))
		registry.MustRegister(reconciliation.ItemResourceMeta(side))
	}
	registry.MustRegister(companyaccountdefault.ResourceMeta())
	registry.MustRegister(orderflow.ResourceMeta())
	for _, resource := range systemops.ResourceMetas() {
		registry.MustRegister(resource)
	}
	registry.MustRegister(fileplatform.FileResourceMeta())
	registry.MustRegister(fileplatform.StorageResourceMeta())
	hasher := auth.NewPasswordHasher(auth.DefaultArgon2Params())
	registry.MustRegister(iam.UserResourceMeta())
	registry.MustRegister(iam.RoleResourceMeta())
	registry.MustRegister(iam.RolePermissionResourceMeta())
	registry.MustRegister(numbering.RuleResourceMeta())
	registry.MustRegister(numbering.CounterResourceMeta())
	registry.MustRegister(printing.ResourceMeta())
	for _, resource := range settings.ResourceMetas() {
		registry.MustRegister(resource)
	}
	authService, err := auth.NewService(
		auth.NewPostgresStore(pool),
		hasher,
		auth.NewTokenManager(cfg.AuthSecret, cfg.TokenTTL),
		auth.NewRateLimiter(5, 15*time.Minute),
	)
	if err != nil {
		return fmt.Errorf("初始化认证服务: %w", err)
	}
	fileService := fileplatform.NewService(pool)
	numberingService := numbering.NewService(pool)
	financeBankingService := banking.NewService(pool, banking.Dependencies{
		Files: fileService, Numberer: numberingService,
	})
	financeDocumentsService := documents.NewService(pool, documents.Dependencies{
		Files: fileService, Numberer: numberingService,
	})
	api := httpapi.New(httpapi.Dependencies{
		Pool: pool, Auth: authService, Registry: registry,
		GLEntries: glentry.NewService(pool), GLJournals: gljournal.NewService(pool, numberingService),
		Currencies: currency.NewService(pool), Companies: company.NewService(pool),
		Units: unit.NewService(pool), Accounts: account.NewService(pool),
		Customers: customer.NewService(pool), Suppliers: supplier.NewService(pool),
		Employees:              employee.NewService(pool, numberingService),
		HROperations:           hroperations.NewService(pool, fileService, numberingService),
		FinanceBanking:         financeBankingService,
		FinanceDocuments:       financeDocumentsService,
		MaterialCats:           materialcategory.NewService(pool),
		Materials:              material.NewService(pool, numberingService),
		MaterialUnits:          materialunit.NewService(pool),
		Warehouses:             warehouse.NewService(pool),
		StockEntries:           stockentry.NewService(pool),
		StockDocs:              stockdoc.NewService(pool, numberingService),
		StockTransfers:         stocktransfer.NewService(pool, numberingService),
		StockCounts:            stockcount.NewService(pool, numberingService),
		Orders:                 order.NewService(pool, numberingService),
		Quotations:             quotation.NewService(pool, numberingService),
		ManufacturingMaster:    master.NewService(pool, numberingService),
		ManufacturingExecution: execution.NewService(pool, numberingService),
		StandardFulfillment:    standard.NewService(pool, numberingService),
		OutsourcedFulfillment:  outsourced.NewService(pool, numberingService),
		Reconciliations:        reconciliation.NewService(pool, numberingService),
		CompanyAccountDefaults: companyaccountdefault.NewService(pool),
		OrderFlowItems:         orderflow.NewService(pool),
		SystemOps:              systemops.NewService(pool),
		FileService:            fileService, StorageService: fileplatform.NewStorageService(pool),
		IAM: iam.NewService(pool, hasher, registry), Numbering: numberingService,
		Printing: printing.NewService(pool, fileService, printing.NewFieldCatalog()),
		Settings: settings.NewService(pool), Logger: logger,
	})
	server := &http.Server{
		Addr: cfg.HTTPAddr, Handler: api.Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("Synie Go API 已启动", "addr", cfg.HTTPAddr)
		serveErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP 服务: %w", err)
		}
		return nil
	case <-rootCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("优雅关闭 HTTP 服务: %w", err)
		}
		if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP 服务关闭: %w", err)
		}
		logger.Info("Synie Go API 已停止")
		return nil
	}
}
