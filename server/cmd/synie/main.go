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
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
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
	api := httpapi.New(httpapi.Dependencies{
		Pool: pool, Auth: authService, Registry: registry,
		GLEntries: glentry.NewService(pool), GLJournals: gljournal.NewService(pool, numberingService),
		Currencies: currency.NewService(pool), Companies: company.NewService(pool),
		Units: unit.NewService(pool), Accounts: account.NewService(pool),
		Customers: customer.NewService(pool), Suppliers: supplier.NewService(pool),
		Employees:      employee.NewService(pool, numberingService),
		MaterialCats:   materialcategory.NewService(pool),
		Materials:      material.NewService(pool, numberingService),
		MaterialUnits:  materialunit.NewService(pool),
		Warehouses:     warehouse.NewService(pool),
		StockEntries:   stockentry.NewService(pool),
		StockDocs:      stockdoc.NewService(pool, numberingService),
		StockTransfers: stocktransfer.NewService(pool, numberingService),
		StockCounts:    stockcount.NewService(pool, numberingService),
		Orders:         order.NewService(pool, numberingService),
		Quotations:     quotation.NewService(pool, numberingService),
		FileService:    fileService, StorageService: fileplatform.NewStorageService(pool),
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
