# 10 — 打印执行面补齐（Go 渲染 + 契约端点 + 前端接通）

**What to build:** 用户在 Go-only 部署下可以对单据执行打印/导出：请求走 OpenAPI 契约内的打印端点，Go 服务端完成 xlsx 模板渲染与 PDF 转换（soffice 管道随服务部署可用），前端打印入口从 Elixir 时代的 `/api/print` 暗管切换到契约客户端。当前「Web Go-only 切流已完成」声明下唯一的产品功能空洞被填上。

**Blocked by:** None — can start immediately

**开工前强制步骤：** 核对 `.scratch/print-engine/`、`.scratch/print-document-pipeline/`、`.scratch/print-pdf-deploy/`、`.scratch/print-universal-catalog/` 与 `plans/001-006` 的既有规划，明确本工单与它们的边界——若既有 spec 已覆盖执行面，本工单改为引用/合并该 spec 的剩余范围，不重复规划；核对结果记录在本文件 Comments 区。

**Status:** ready-for-agent

- [ ] 既有打印规划边界核对完成并记录，本工单范围据此裁剪
- [ ] OpenAPI 契约新增打印/渲染端点，服务端经 oapi-codegen 编译期绑定实现
- [ ] Go 侧 xlsx 渲染（占位符填充、循环区）与 PDF 转换可用，与捕获的打印契约（字段目录 60 资源/1223 头字段/28 循环区）对齐
- [ ] 前端打印/导出全部走契约客户端，`/api/print` 暗管清零
- [ ] 至少一个业务单据（建议销售订单，对齐 print-engine 先例）端到端打印验证通过（真实 PG + 浏览器）
