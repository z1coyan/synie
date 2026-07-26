// Package metaregistry centralizes Meta resource registration so the process
// bootstrap and isolation invariant tests share one source of truth.
package metaregistry

import (
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
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/iam"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/printing"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

// RegisterAll registers every public Meta resource exposed by the Go server.
func RegisterAll(registry *meta.Registry) {
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
	registry.MustRegister(iam.UserResourceMeta())
	registry.MustRegister(iam.RoleResourceMeta())
	registry.MustRegister(iam.RolePermissionResourceMeta())
	registry.MustRegister(numbering.RuleResourceMeta())
	registry.MustRegister(numbering.CounterResourceMeta())
	registry.MustRegister(printing.ResourceMeta())
	for _, resource := range settings.ResourceMetas() {
		registry.MustRegister(resource)
	}
}
