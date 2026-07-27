package metaregistry_test

import (
	"testing"

	"github.com/z1coyan/synie/server/internal/app/metaregistry"
	"github.com/z1coyan/synie/server/internal/platform/files"
)

// expectedFileOwners 是附件宿主归属的行为基线（原 platform/files 硬编码清单），
// 与 companyFilterRequired 同一清单对拍风格：领域包漏注册、多注册或改值都会失败。
var expectedFileOwners = map[string]files.OwnerSpec{
	"sal_customer":         {Table: "sal_customers", PermissionPrefix: "sales.customer"},
	"sal_order_item":       {Table: "sal_order_item", PermissionPrefix: "sales.order", CompanyScoped: true},
	"sal_delivery_item":    {Table: "sal_delivery_item", PermissionPrefix: "sales.delivery", CompanyScoped: true},
	"pur_supplier":         {Table: "pur_supplier", PermissionPrefix: "purchase.supplier"},
	"pur_order_item":       {Table: "pur_order_item", PermissionPrefix: "purchase.order", CompanyScoped: true},
	"pur_receipt_item":     {Table: "pur_receipt_item", PermissionPrefix: "purchase.receipt", CompanyScoped: true},
	"hr_employee":          {Table: "hr_employees", PermissionPrefix: "hr.employee"},
	"inv_material":         {Table: "inv_material", PermissionPrefix: "inv.material"},
	"acc_gl_journal":       {Table: "acc_gl_journal", PermissionPrefix: "acc.gl_journal", CompanyScoped: true},
	"acc_bank_account":     {Table: "acc_bank_account", PermissionPrefix: "acc.bank_account", CompanyScoped: true},
	"acc_bank_transaction": {Table: "acc_bank_transaction", PermissionPrefix: "acc.bank_transaction", CompanyScoped: true},
	"acc_vat_invoice":      {Table: "acc_vat_invoice", PermissionPrefix: "acc.vat_invoice", CompanyScoped: true},
	"acc_bill":             {Table: "acc_bill", PermissionPrefix: "acc.bill"},
	"acc_bill_transaction": {Table: "acc_bill_transaction", PermissionPrefix: "acc.bill_transaction", CompanyScoped: true},
	"sys_print_template":   {Table: "sys_print_template", PermissionPrefix: "sys.print_template"},
}

func TestRegisterFileOwnersMatchesBaseline(t *testing.T) {
	metaregistry.RegisterFileOwners()
	registered := files.RegisteredOwners()

	for ownerType, want := range expectedFileOwners {
		got, ok := registered[ownerType]
		if !ok {
			t.Errorf("附件宿主 %s 未注册——检查对应领域包的 FileOwnerSpecs 与 metaregistry.RegisterFileOwners", ownerType)
			continue
		}
		if got != want {
			t.Errorf("附件宿主 %s = %+v, 期望 %+v", ownerType, got, want)
		}
	}
	for ownerType := range registered {
		if _, ok := expectedFileOwners[ownerType]; !ok {
			t.Errorf("附件宿主 %s 已注册但不在基线清单中——新增归属需同步更新本测试", ownerType)
		}
	}
}
