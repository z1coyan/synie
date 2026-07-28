# 08 H · 权限双检：先定成文约定，再收敛存量

Status: resolved

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

## 收敛清单（完成）

顺序曾遵守：**先补 service 缺失检 → 再删 routes 同源中间件**。

| 域 | 动作 | Commit |
|----|------|--------|
| banking-recon 快速对账 | 只检 reconcile | `15a2356` |
| trading / finance / accounting | 去 routes 双检 | `bf949f5` |
| party / iam / sales | 补 service + 去 routes | `4cc4527` |
| platform（audit/numbering/settings/files/storage/printing） | 补 service + 去 routes | `22a13f1` |
| inventory | 补 service + 去 routes | `f546972` |
| manufacturing | 补 service + 去 routes | `f85dc21` |
| base / market | 补 service + 去 routes | `d57265c` |
| hr | 补读路径 actor + 去 routes | `1d6bb30` |

## Comments

### 2026-07-28 决策落地

- 方案一成文 `server/README.md` §8；banking-recon 只 reconcile（`15a2356`）。
- 第一刀 trading/finance/accounting 去 routes（`bf949f5`）。

### 2026-07-28 全量收敛完成

- party/iam/sales → `4cc4527`
- platform → `22a13f1`
- inventory → `f546972`；manufacturing → `f85dc21`
- base/market → `d57265c`；hr → `1d6bb30`
- 验收：`bun run typecheck` 绿；全量 `bun test` **246/246**。
- `*routes*.ts` 中 `requirePerm` / `requirePermission` 为零（仅 `requireAuth`）。

### 无闸 seam（刻意保留）

- `numbering.next` / `nextInTx` — 业务取号基础设施
- `files.readStoredFile` — 跨模块读文件字节
- `settings.loadSystemConfig` — 调度/行情配置
- market `takeQuote` / 调度 null-actor 刷新
- 会计 `createAndAuditJournal` 等跨域 seam（调用方业务码覆盖）

## 备注

- 新代码禁止在 routes 加鉴码；公开 service 方法首行 `requirePermission`。
- 反射化后 enforcement 迁框架策略层，仍单点。
