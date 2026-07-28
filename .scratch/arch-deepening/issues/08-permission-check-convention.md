# 08 H · 权限双检：先定成文约定，再收敛存量

Status: ready-for-human

## 问题

同一权限码在 route 中间件与 service 首行各查一遍：trading 全域
service 侧 ~105 处 + routes 侧 ~112 处，且**同源**（都读 `spec.prefix`）——
双检没有带来 defense-in-depth 的第二信息源。更实质的问题：

- 域间策略分裂：trading/finance/hr/accounting 双检，iam/base/party 单检；
- 鉴权与 zValidator 顺序不一：`audit/routes.ts:29` 特意 requirePerm 先于
  body 解析（畸形 body 得 403），其他资源相反（得 400）；
- 没有成文约定，新模块只能照抄最近看到的那个。

## 待决策（与用户讨论）

方案一：**service 唯一检**——内部调用（service 调 service）天然被覆盖，
routes 只做 requireAuth；代价是失去「先于 body 解析拒绝」。
方案二：**routes 声明式鉴码**——统一先于 zValidator，service 信任上层、
内部复用经窄 Pick 接口（权限码挂接口声明）。

## 决策后动作

- 约定写进 `server/README.md` 编码约定；
- 按约定收敛存量域（消除分裂与顺序不一）。

## 备注

- banking-recon 的快速对账当前要求 `acc.gl_journal:create/audit` 双权限码
  （第一轮 B-α 保留未动）——归属本议题一并定夺。
