package printing

import "github.com/z1coyan/synie/server/internal/platform/files"

// FileOwnerSpecs 声明打印模板可挂附件，由 metaregistry 启动时统一注册。
func FileOwnerSpecs() map[string]files.OwnerSpec {
	return map[string]files.OwnerSpec{
		"sys_print_template": {Table: "sys_print_template", PermissionPrefix: "sys.print_template"},
	}
}
