# Spec: PDF 转换与部署基线

**Status:** ready-for-agent  
**Feature slug:** `print-pdf-deploy`  
**Depends on:** None for the converter module itself（可与引擎并行）；端到端验收依赖本机或镜像内有 LibreOffice  
**Blocks:** `print-document-pipeline` 的「打印→PDF」路径（导出路径不依赖本 spec）  
**ADR:** [docs/adr/2026-07-23-print-template.md](../../docs/adr/2026-07-23-print-template.md)  
**Domain terms:** 模板打印/模板导出（打印=填充后转 PDF）

---

## Problem Statement

模板打印要把填充后的 xlsx 变成 PDF 交给浏览器。LibreOffice headless 是已定案的哑转换器，但进程并发、路径配置、中文字体与生产镜像若未一次性收口，打印会在「开发机能转、生产乱码/挂死」上翻车。导出 Excel 不得被 PDF 故障拖死。

## Solution

提供独立的 **PDF 转换 seam**：输入 xlsx 二进制，输出 PDF 二进制；soffice 路径可配置；每次转换使用独立临时 user profile，避免并发锁；转换失败返回明确错误。生产 Docker 镜像内置 LibreOffice Calc 与 Noto CJK 字体。导出路径永不调用本模块。

## User Stories

1. As a 打印管线, I want 把填充后的 xlsx 转为 PDF binary, so that 浏览器可预览/打印/另存
2. As a 运维, I want soffice 可执行路径可配置, so that 开发机与容器路径不同仍能工作
3. As a 运维, I want 默认能在 PATH 上找到 `soffice`, so that 镜像内无需再设环境变量
4. As a 系统, I want 并发两次转换互不踩 profile 锁, so that 多用户同时打印不失败
5. As a 业务用户, I want 转换失败时看到明确中文错误, so that 知道是服务问题而非模板问题
6. As a 业务用户, I want PDF 服务不可用时导出 Excel 仍可用, so that 出单不中断
7. As a 运维, I want 生产镜像含 LibreOffice 与中文字体, so that 中文单据不乱码
8. As a 运维, I want 后端可 release 进 Docker 运行, so that 打印依赖与应用同生命周期
9. As a 开发者, I want 本地无 soffice 时相关测试可跳过或打 tag, so that CI 默认不强制装 LO
10. As a 打印管线, I want 转换严格使用模板内页面设置, so that 纸张/方向/页边距不被转换器擅自改掉
11. As a 运维, I want 转换临时文件用后清理, so that 磁盘不堆积
12. As a 开发者, I want 配置项集中（如 `SOFFICE_PATH`）, so that 与现有 env 风格一致

## Implementation Decisions

### 模块 seam：`SynieCore.Printing.PdfConverter`（名称可微调）

```elixir
# 决策级接口形状
convert_xlsx_to_pdf(xlsx_binary) :: {:ok, pdf_binary} | {:error, term}
```

- 实现要点：
  - 写临时目录：输入 `.xlsx`、独立 `-env:UserInstallation=file://...` profile 目录
  - 调用：`soffice --headless --convert-to pdf --outdir ...`（参数以实现期 LO 版本文档为准）
  - 读回生成的 `.pdf`；确保成功与失败路径都删除临时目录
  - 超时：须有进程超时，避免 soffice 挂死占住请求（具体秒数实现期定，建议可配置）
- 配置：`Application.get_env` / 环境变量 `SOFFICE_PATH`，默认 `"soffice"`。
- 错误映射：可执行文件不存在、非零退出、无输出文件、超时 → 稳定 error 原子或中文 message，供 GraphQL/控制器展示。
- **禁止**在转换路径做占位符填充、改 page setup、合并 PDF。
- 本模块不感知模板或单据；只做文件格式转换。

### 与导出的切割

- 任何「导出 xlsx」代码路径**不得** import/调用 PdfConverter。
- 打印路径：Renderer → PdfConverter；导出路径：Renderer → 直接下发 xlsx。

### 部署

- 提供后端生产 Dockerfile（构建上下文在 backend/ 或仓库约定位置）：
  - multi-stage：编译 umbrella release（`synie_core` + `synie_web`）
  - runner：安装 libreoffice-calc（或等价最小包）+ 字体（Noto CJK）
  - 暴露 PORT；`DATABASE_URL` / `SECRET_KEY_BASE` / `PHX_HOST` 等与现有 prod 配置对齐
  - 文档注释写明 `SOFFICE_PATH` 可选
- umbrella 根 `mix.exs` 增加 release 定义（若尚未有），供 Docker 构建。
- prod runtime：容器内 HTTP 监听 `0.0.0.0` 与 PORT（若当前 prod 未设）。
- **前端**仍独立部署；镜像不打包 web/ 的 SPA（与现架构一致）。

### 验收点（ADR）

- 带明确 page setup / 打印区域的模板，转 PDF 后版式与 Excel 打印预览一致（人工或抽样对照）；系统不得在转换前改页边距。

### 明确不做

- 不引入 qpdf/pdfcpu 等 PDF 合并库
- 不做异步转换队列（批量上限与同步策略在 pipeline）
- 不在本 spec 实现业务 print action

## Testing Decisions

- **好测试**：对 Converter 公共 API——成功时 PDF 魔数 `%PDF`；失败时 error 形状稳定。不测 LO 排版像素。
- **分层**：
  - 无 soffice：单元测「路径不存在」错误；可用 mock/假可执行脚本模拟成功与失败（优先）
  - 有 soffice：打 tag（如 `:libreoffice`）的集成测，默认 exclude，本地/专用 CI 可选跑
- **Docker**：不在 ExUnit 里 build 镜像；Dockerfile 语法与文档在实现 PR 中人工或 CI hadolint（可选）。
- **Prior art**：OCR 客户端对外部进程/HTTP 的错误包装；`Config` 读 env 模式。

## Out of Scope

- XLSX 填充（`print-xlsx-engine`）
- 模板主数据（`print-template-master`）
- 销售单据 UI 与权限动作接线（`print-document-pipeline`）
- Windows 安装包、非 Docker 的完整运维手册（README 一段即可）
- 前端「下载 PDF」独立按钮（浏览器另存即可）

## Further Notes

- 可与 `print-xlsx-engine` 完全并行开发。
- 若本地开发不想装 LO：只做导出联调；打印联调在 Docker 或安装 libreoffice 后进行。
- 关联总览：`.scratch/print-engine/map.md`。
