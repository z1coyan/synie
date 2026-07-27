package metaregistry_test

import (
	"sort"
	"testing"

	"github.com/z1coyan/synie/server/internal/app/metaregistry"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

// companyFilterExempt lists registry resources that have a company_id /
// companyId field but intentionally do NOT apply actor company isolation on
// List (or the field is not a tenancy key). Reasons are mandatory.
//
// Global masters without company_id (currency, unit, market, materials,
// parties, HR attendance punches, settings, IAM, numbering, printing, files…)
// never appear here — they simply lack the field.
var companyFilterExempt = map[string]string{
	// 审计日志允许 company_id IS NULL 的全局事件；List 用 allowGlobal 分支
	// （NULL 或授权公司），不是纯 company_id ANY 过滤。
	"sysAuditLogs": "nullable company_id with allow-global audit visibility",
}

// companyFilterRequired is the explicit inventory of registered resources
// whose List path must apply fail-closed company isolation via
// filterbuild.AppendCompanyFilter / ApplyCompanyFilter / ResolveCompanyScope.
// Kept in sync with meta.Registry by TestCompanyFilterInventoryMatchesRegistry.
//
// Child/line resources that carry denormalized company_id are included when
// their List is independently queryable.
var companyFilterRequired = map[string]struct{}{
	"accGlEntries":                       {},
	"accGlJournals":                      {},
	"accGlJournalLines":                  {},
	"basAccounts":                        {},
	"accBankAccounts":                    {},
	"accBankTransactions":                {},
	"accBankImportTemplates":             {},
	"accBankImports":                     {},
	"accBankImportItems":                 {},
	"accBankReconciliations":             {},
	"accVatInvoices":                     {},
	"accExpenseReports":                  {},
	"accExpenseReportItems":              {},
	"accBillTransactions":                {},
	"accBillHoldings":                    {},
	"invWarehouses":                      {},
	"invStockEntries":                    {},
	"invStockDocs":                       {},
	"invStockDocItems":                   {},
	"invStockTransfers":                  {},
	"invStockTransferItems":              {},
	"invStockCounts":                     {},
	"invStockCountItems":                 {},
	"salQuotations":                      {},
	"salQuotationItems":                  {},
	"salQuotationTiers":                  {},
	"purQuotations":                      {},
	"purQuotationItems":                  {},
	"purQuotationTiers":                  {},
	"salOrders":                          {},
	"salOrderItems":                      {},
	"purOrders":                          {},
	"purOrderItems":                      {},
	"purOrderItemMaterials":              {},
	"purOrderItemByproducts":             {},
	"mfgDemands":                         {},
	"mfgDemandItems":                     {},
	"mfgWorkOrders":                      {},
	"mfgOutputs":                         {},
	"mfgOutputItems":                     {},
	"salDeliveries":                      {},
	"salDeliveryItems":                   {},
	"purReceipts":                        {},
	"purReceiptItems":                    {},
	"purOutsourcedIssues":                {},
	"purOutsourcedIssueItems":            {},
	"purOutsourcedReceipts":              {},
	"purOutsourcedReceiptItems":          {},
	"purOutsourcedReceiptItemMaterials":  {},
	"purOutsourcedReceiptItemByproducts": {},
	"salReconciliations":                 {},
	"salReconciliationItems":             {},
	"purReconciliations":                 {},
	"purReconciliationItems":             {},
	"salCompanyAccountDefaults":          {},
	"scmOrderFlowItems":                  {},
}

func resourceHasCompanyField(resource meta.ResourceMeta) bool {
	for _, field := range resource.Fields {
		if field.DBColumn == "company_id" || field.APIName == "companyId" || field.Name == "company_id" {
			return true
		}
	}
	return false
}

func TestCompanyFilterInventoryMatchesRegistry(t *testing.T) {
	registry := meta.NewRegistry()
	metaregistry.RegisterAll(registry)

	var withCompany []string
	for _, resource := range registry.Resources() {
		if resourceHasCompanyField(resource) {
			withCompany = append(withCompany, resource.Name)
		}
	}
	sort.Strings(withCompany)

	seen := make(map[string]struct{}, len(withCompany))
	for _, name := range withCompany {
		seen[name] = struct{}{}
		_, required := companyFilterRequired[name]
		reason, exempt := companyFilterExempt[name]
		switch {
		case required && exempt:
			t.Errorf("resource %s listed as both required and exempt", name)
		case !required && !exempt:
			t.Errorf("resource %s has company_id/companyId but is neither in companyFilterRequired nor companyFilterExempt — add it with a reason", name)
		case exempt && reason == "":
			t.Errorf("exempt resource %s missing reason", name)
		}
	}

	for name := range companyFilterRequired {
		if _, ok := seen[name]; !ok {
			t.Errorf("companyFilterRequired lists %s but registry has no such resource with company_id", name)
		}
	}
	for name := range companyFilterExempt {
		if _, ok := seen[name]; !ok {
			t.Errorf("companyFilterExempt lists %s but registry has no such resource with company_id", name)
		}
	}

	// Resources without company_id must stay out of the required inventory
	// (global masters / employee-scoped HR punches etc.).
	for _, resource := range registry.Resources() {
		if resourceHasCompanyField(resource) {
			continue
		}
		if _, ok := companyFilterRequired[resource.Name]; ok {
			t.Errorf("companyFilterRequired lists %s which has no company_id field", resource.Name)
		}
	}
}

func TestGlobalResourcesWithoutCompanyIDDocumented(t *testing.T) {
	// Explicit sample of global / non-tenant resources that must remain
	// unfiltered by company. If any of these gains a company_id field the
	// inventory test above will force a decision.
	global := []string{
		"basCurrencies",       // 全局币种主数据
		"basUnits",            // 全局计量单位
		"hrAttendancePunches", // 打卡按员工，无 company_id
		"hrAttendanceDays",
		"hrAttendanceCorrections",
		"hrPayrolls",
		"invMaterials",
		"invMaterialCategories",
		"purSuppliers",
		"salCustomers",
		"hrEmployees",
		"sysUsers",
		"sysRoles",
	}
	registry := meta.NewRegistry()
	metaregistry.RegisterAll(registry)
	for _, name := range global {
		resource, ok := registry.Get(name)
		if !ok {
			t.Fatalf("expected global resource %s in registry", name)
		}
		if resourceHasCompanyField(resource) {
			t.Errorf("global resource %s unexpectedly has company_id — move into required/exempt inventory", name)
		}
	}
}
