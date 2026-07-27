package banking

import "github.com/z1coyan/synie/server/internal/platform/files"

// FileOwnerSpecs 声明本领域可挂附件的宿主资源，由 metaregistry 启动时统一注册。
func FileOwnerSpecs() map[string]files.OwnerSpec {
	return map[string]files.OwnerSpec{
		"acc_bank_account":     {Table: "acc_bank_account", PermissionPrefix: "acc.bank_account", CompanyScoped: true},
		"acc_bank_transaction": {Table: "acc_bank_transaction", PermissionPrefix: "acc.bank_transaction", CompanyScoped: true},
	}
}
