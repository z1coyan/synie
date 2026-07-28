# 01 平台层补全：settings / numbering / audit / files

Status: ready-for-agent
Blocked by: 无

## 范围

在既有骨架上补全四个平台模块（编码约定见 `server/README.md`，一律工厂闭包）：

1. **settings**：`sys_setting`/`acc_setting`/`sal_setting`/`mfg_setting` 四个单行表资源——`GET/PATCH /api/v1/{sys,acc,sales,mfg}/setting`（无 list/create/delete；种子行恒存在；密钥字段 write-only 只写不回读）。
2. **numbering**：编号规则 CRUD + 取号服务（固定文本/记录字段/序号段组合；序号按段渲染结果及公司隐含范围独立计数；padding 0 不补零、1..12 补零；字段段空则省略）+ 计数器校正（必留审计）+ 删规则级联删计数器。
3. **audit**：字段级写操作留痕（旧值→新值，只增不改不删）；敏感字段不落值（Meta `audit.sensitiveFields` 驱动）；提供 service 钩子供各域 create/update/delete 调用。
4. **files**：`sys_file`（不可变、≤50MB、SHA-256）+ `sys_storage` 存储接入点（本地/S3 兼容；全局恰一个默认，切换串行化；访问密钥只写不回读）+ `sys_attachment` 挂接（宿主白名单 fail-closed，公司归属固化；有挂接不可删；列表/下载按公司范围+宿主读权限）。

## 行为参考

`server-go/internal/platform/{settings,numbering,audit,files}/`（服务与 SQL）；wire 形状对齐 `contracts/openapi/openapi.yaml` 对应端点。

## 验收

- `SYNIE_API_URL=http://localhost:8081/api/v1 bun .scratch/migration/verify-settings-rest.ts` 与 `verify-numbering-rest.ts` 全绿（脚本 env 名顺带泛化：新增 `SYNIE_API_URL`，保留 `GO_API_URL` 兼容）
- audit/files 的 bun 单测 + PG 集成测试（`SYNIE_TEST_DATABASE_URL`）
- `bun test` + `bunx tsc --noEmit` 绿；路由链式挂载（ApiType 不断链）

## 非目标

不做 OCR 配置面以外的 OCR 调用实现（随发票工单 09）；不做 S3 multipart 高级特性（对齐 Go 现状即可）。
