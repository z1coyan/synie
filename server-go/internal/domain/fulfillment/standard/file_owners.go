package standard

import "github.com/z1coyan/synie/server/internal/platform/files"

// FileOwnerSpecs 声明本领域可挂附件的宿主资源（销售发货行/采购入库行），
// 由 metaregistry 启动时统一注册；表名与权限前缀复用 sideSpec，避免两处漂移。
func FileOwnerSpecs() map[string]files.OwnerSpec {
	decls := make(map[string]files.OwnerSpec, len(specs))
	for _, spec := range specs {
		decls[spec.itemOwnerType] = files.OwnerSpec{
			Table:            spec.itemTable,
			PermissionPrefix: spec.prefix,
			CompanyScoped:    true,
		}
	}
	return decls
}
