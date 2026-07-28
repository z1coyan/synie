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

	"github.com/z1coyan/synie/server/internal/app/metaregistry"
	"github.com/z1coyan/synie/server/internal/db"
	"github.com/z1coyan/synie/server/internal/domain/accounting/glentry"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/base/currency"
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
	"github.com/z1coyan/synie/server/internal/jobs/marketsched"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/config"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/iam"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/printing"
	"github.com/z1coyan/synie/server/internal/platform/settings"
	setupplatform "github.com/z1coyan/synie/server/internal/platform/setup"
	"github.com/z1coyan/synie/server/internal/platform/setup/sampledata"
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
	metaregistry.RegisterAll(registry)
	metaregistry.RegisterFileOwners()
	hasher := auth.NewPasswordHasher(auth.DefaultArgon2Params())
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
	accountService := account.NewService(pool)
	companyAccountDefaultService := companyaccountdefault.NewService(pool)
	warehouseService := warehouse.NewService(pool)
	customerService := customer.NewService(pool)
	supplierService := supplier.NewService(pool)
	materialService := material.NewService(pool, numberingService)
	materialUnitService := materialunit.NewService(pool)
	employeeService := employee.NewService(pool, numberingService)
	hrOperationsService := hroperations.NewService(pool, fileService, numberingService)
	quotationService := quotation.NewService(pool, numberingService)
	orderService := order.NewService(pool, numberingService)
	standardFulfillmentService := standard.NewService(pool, numberingService)
	outsourcedFulfillmentService := outsourced.NewService(pool, numberingService)
	reconciliationService := reconciliation.NewService(pool, numberingService)
	stockDocService := stockdoc.NewService(pool, numberingService)
	stockTransferService := stocktransfer.NewService(pool, numberingService)
	stockCountService := stockcount.NewService(pool, numberingService)
	manufacturingMasterService := master.NewService(pool, numberingService)
	glJournalService := gljournal.NewService(pool, numberingService)
	setupService := setupplatform.NewService(pool, hasher, auth.NewTokenManager(cfg.AuthSecret, cfg.TokenTTL), sampledata.Dependencies{
		Pool: pool, Accounts: accountService, CompanyAccountDefaults: companyAccountDefaultService,
		Warehouses: warehouseService, Customers: customerService, Suppliers: supplierService,
		Materials: materialService, MaterialUnits: materialUnitService, Employees: employeeService,
		Quotations: quotationService, Orders: orderService,
		StandardFulfillment: standardFulfillmentService, OutsourcedFulfillment: outsourcedFulfillmentService,
		Reconciliations: reconciliationService, StockDocs: stockDocService,
		StockTransfers: stockTransferService, StockCounts: stockCountService,
		ManufacturingMaster: manufacturingMasterService, Banking: financeBankingService,
		GLJournals: glJournalService, Documents: financeDocumentsService, HROperations: hrOperationsService,
	})
	api := httpapi.New(httpapi.Dependencies{
		Pool: pool, Auth: authService, Registry: registry,
		GLEntries: glentry.NewService(pool), GLJournals: glJournalService,
		Currencies: currency.NewService(pool), Companies: company.NewService(pool),
		Units: unit.NewService(pool), Accounts: accountService,
		Customers: customerService, Suppliers: supplierService,
		Employees:              employeeService,
		HROperations:           hrOperationsService,
		FinanceBanking:         financeBankingService,
		FinanceDocuments:       financeDocumentsService,
		MaterialCats:           materialcategory.NewService(pool),
		Materials:              materialService,
		MaterialUnits:          materialUnitService,
		Warehouses:             warehouseService,
		StockEntries:           stockentry.NewService(pool),
		StockDocs:              stockDocService,
		StockTransfers:         stockTransferService,
		StockCounts:            stockCountService,
		Orders:                 orderService,
		Quotations:             quotationService,
		ManufacturingMaster:    manufacturingMasterService,
		ManufacturingExecution: execution.NewService(pool, numberingService),
		StandardFulfillment:    standardFulfillmentService,
		OutsourcedFulfillment:  outsourcedFulfillmentService,
		Reconciliations:        reconciliationService,
		CompanyAccountDefaults: companyAccountDefaultService,
		OrderFlowItems:         orderflow.NewService(pool),
		SystemOps:              systemops.NewService(pool),
		FileService:            fileService, StorageService: fileplatform.NewStorageService(pool),
		IAM: iam.NewService(pool, hasher, registry), Numbering: numberingService,
		Printing: printing.NewService(pool, fileService, printing.NewFieldCatalog(registry)),
		Settings: settings.NewService(pool),
		Setup:    setupService, Logger: logger,
	})
	// 行情定时调度:随服务进程启动,rootCtx 取消即优雅退出;
	// 开关/间隔读 sys_setting,每分钟一个节拍,设置变更下一节拍生效
	go marketsched.New(pool, logger).Run(rootCtx)

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
