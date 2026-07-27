package documents

import "github.com/z1coyan/synie/server/internal/platform/files"

// FileOwnerSpecs 声明本领域可挂附件的宿主资源，由 metaregistry 启动时统一注册。
func FileOwnerSpecs() map[string]files.OwnerSpec {
	return map[string]files.OwnerSpec{
		"acc_vat_invoice":      {Table: "acc_vat_invoice", PermissionPrefix: "acc.vat_invoice", CompanyScoped: true},
		"acc_bill":             {Table: "acc_bill", PermissionPrefix: "acc.bill"},
		"acc_bill_transaction": {Table: "acc_bill_transaction", PermissionPrefix: "acc.bill_transaction", CompanyScoped: true},
	}
}
