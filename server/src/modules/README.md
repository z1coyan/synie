# modules/ — 业务域（workflow 填充）

每域一个目录，统一四件套（可按域复杂度裁剪合并，但依赖方向不变）：

```
modules/<domain>/
├── meta.ts       # ResourceMeta 注册（字段/动作/权限/打印声明）
├── routes.ts     # Hono 子路由（链式 + zValidator，供 hc 类型推断）
├── service.ts    # 领域服务（工厂闭包；接 DbHandle；过账走 withTx + engines）
└── *.test.ts     # 单测；PG 集成门控 SYNIE_TEST_DATABASE_URL
```

硬规则：
1. 域间依赖单向（sales/purchase → engines → platform），跨域用显式参数，禁止环。
2. wire 形状（URL/JSON/错误文案）与 server-go + 原 OpenAPI 对齐；verify 脚本见
   `.scratch/migration/verify-*.ts`（改为打 Bun server 后即验收工具）。
3. 每域落地即在 `src/index.ts` 的 registerAll 处注册 meta 并挂载路由。

实现顺序与验收：`.scratch/ts-backend-rewrite/spec.md` 与 issues/。
