# 专用流程切到 Go REST

Status: resolved

Blocked by: 01

## 范围

- 初始化向导 setup。
- 银行导入、银行对账、OCR、审核弹窗等残留生产调用。
- 删除已被新 REST 页面私有实现替代且无生产引用的旧组件。
- 补齐 registry 漏项。

## 完成定义

`web/app` 非测试生产代码不存在 `gqlFetch`；所有保留流程均走 OpenAPI client 或资源 client。

## Comments

### 2026-07-26

- 银行/OCR 等旧 GraphQL 组件已删；字面量构造层已删。
- Setup 向导：`feat(web): 将初始化向导切到 Go REST`（worktree cherry-pick 至主工作树）。
