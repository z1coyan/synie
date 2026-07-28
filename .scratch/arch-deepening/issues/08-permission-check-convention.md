# 08 H · 权限双检：先定成文约定，再收敛存量

Status: ready-for-agent

## 问题

同一权限码在 route 中间件与 service 首行各查一遍：trading 全域
service 侧 ~105 处 + routes 侧 ~112 处，且**同源**（都读 `spec.prefix`）——
双检没有带来 defense-in-depth 的第二信息源。更实质的问题：

- 域间策略分裂：trading/finance/hr/accounting 双检，iam/base/party 单检；
- 鉴权与 zValidator 顺序不一：`audit/routes.ts:29` 特意 requirePerm 先于
  body 解析（畸形 body 得 403），其他资源相反（得 400）；
- 没有成文约定，新模块只能照抄最近看到的那个。

## 决策（2026-07-28）

**采用方案一：service 唯一检**（面向未来元数据反射化）。

- 运行时唯一 enforcement 点在 service；routes 只做 `requireAuth`。
- 跨域 seam 无权限闸，调用方业务能力码覆盖。
- 快速对账只检 `acc.bank_transaction:reconcile`，不叠
  `acc.gl_journal:create/audit`。
- 反射化后 enforcement 迁框架策略层，仍保持单点，禁止回到双检。
- 成文：`server/README.md` 编码约定第 8 条。

## 收敛清单

顺序：**先补 service 缺失检 → 再删 routes 同源中间件**（禁止先删 routes 造成裸奔）。

| 域 | 现状 | 动作 |
|----|------|------|
| trading / finance(ops) / hr / accounting | 双检或 service 已有 | 去 routes `requirePerm` |
| inventory / manufacturing / party / iam / base / sales | routes 单检 | 先补 service 首行检，再去 routes |
| platform numbering/settings/audit/files/printing | 不一 | 对齐 service 唯一检 |
| banking-recon 快速对账 | create+audit 叠码 | ✅ 已改为只 reconcile |

## 备注

- 收敛完成前 routes 中间件仍可能存在（安全网）；以 README 约定为准，新代码不得新增 routes 鉴码。
