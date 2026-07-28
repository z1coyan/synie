# 16 setup 向导 + 全链示例数据

Status: ready-for-agent
Blocked by: 06, 07, 08, 10, 11, 12, 13

## 范围

1. **Setup 端点**（`/api/v1/setup/status|first-user|currencies|complete`；同一 PG 事务级 Setup 锁；首用户并发只允许一个成功，置 super_admin+all_companies 并返回 JWT；完成=写首选语言+幂等基础种子（编号规则/物料两级分类/机加工单位/存储接入）+可选示例数据+落 setup_completed_at；示例失败不落旗标）
2. **示例数据**（客户 C01 幂等：覆盖客商/物料/员工主数据、销售全链（报价→订单→发货→对账→发票结单）、采购全链、委外全链、库存三单、工序/工艺/BOM、银行流水、手工凭证、报销单、工资单、销/进项发票；近 3 个月日期分布）
3. demo 快捷种子（`bun run db:seed:demo`，等价旧 mix synie.demo：admin/admin123 + JT 公司 + 示例数据）

## 行为参考

`server-go/internal/platform/setup/`（含 sampledata）；CONTEXT「初始化向导」「示例数据」词条。

## 验收

- 空库端到端：migrate → setup/status → first-user → complete(含示例) → 登录 → 关键列表/单据冒烟
- 示例数据幂等（重复 complete 不产生重复 C01）
- 并发 first-user 仅一成功

## 非目标

不做向导 UI 改版（前端现状对齐即可）。
