# numbering

编号规则 CRUD + 取号服务 + 计数器校正（必留审计）；删规则级联删计数器。
- 字段目录：自 meta.Registry 派生（`catalog.ts`，资源声明 `numbering: true`），composition.ts 装配
- 兼容约束：DB 规则按 (prefix, path) 引用目录字段，派生结果须为旧目录超集（`catalog.test.ts` 特征化测试，fixture 在 `test/fixtures/numberables.json`）
- 端点：`/api/v1/system/numbering/{resources,rules,counters}`
- 行为参考：`server-go/internal/platform/numbering/`
