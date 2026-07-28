package material

import "github.com/z1coyan/synie/server/internal/platform/files"

// FileOwnerSpecs 声明本领域可挂附件的宿主资源，由 metaregistry 启动时统一注册。
func FileOwnerSpecs() map[string]files.OwnerSpec {
	return map[string]files.OwnerSpec{
		"inv_material": {Table: "inv_material", PermissionPrefix: "inv.material"},
	}
}
