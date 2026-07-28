package files_test

import (
	"github.com/z1coyan/synie/server/internal/app/metaregistry"
)

// files 的归属注册表改由领域包声明、metaregistry 装配。本包既有行为测试
// （service_postgres_test.go / strict_postgres_test.go）在真实库上走
// resolveOwner，启动时先完成与生产一致的装配，使 files 包内不出现任何
// 领域表名/权限前缀字面量。
func init() {
	metaregistry.RegisterFileOwners()
}
