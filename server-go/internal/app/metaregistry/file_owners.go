package metaregistry

import (
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/printing"
)

// RegisterFileOwners 汇总各领域包声明的附件宿主归属（FileOwnerSpecs）并注册到
// files 平台。进程启动时必须且只能调用一次——重复注册会 panic（与
// meta.Registry.MustRegister 同一先例），resolveOwner 在此之后才能使用。
func RegisterFileOwners() {
	declarations := []map[string]fileplatform.OwnerSpec{
		customer.FileOwnerSpecs(),
		supplier.FileOwnerSpecs(),
		employee.FileOwnerSpecs(),
		material.FileOwnerSpecs(),
		order.FileOwnerSpecs(),
		standard.FileOwnerSpecs(),
		gljournal.FileOwnerSpecs(),
		banking.FileOwnerSpecs(),
		documents.FileOwnerSpecs(),
		printing.FileOwnerSpecs(),
	}
	for _, declared := range declarations {
		for ownerType, spec := range declared {
			fileplatform.RegisterOwner(ownerType, spec)
		}
	}
}
