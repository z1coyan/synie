# Spec: 对手地址（客商/内部公司从属地址）

**Status:** done  
**Feature slug:** `party-address`  
**ADR:** [docs/adr/2026-08-02-party-address.md](../../docs/adr/2026-08-02-party-address.md)  
**Domain terms:** 地址、地址用途、默认地址、对手（见 `CONTEXT.md`）  
**Depends on:** 客户 / 供应商 / 公司主数据（已交付）

---

## Problem Statement

客户、供应商、内部公司目前只有编号与名称，没有可复用的结构化地址。履约时需要知道「货送到哪 / 从哪取」，通信时需要办公/联系地址；若做独立地址总库，用户会先去地址页配半天再回头挂接，摩擦大。发票票面地址电话仍是自由文本，本期不结构化。

## Solution

引入**从属单方**的**地址**主数据：每条地址必挂且仅挂一个主体（客户 / 供应商 / 内部公司），一主体可多条。主要维护入口在三个主体抽屉内「地址」区，**不设独立地址菜单**。用途分收发货 / 通信办公 / 其他；同主体同用途至多一个默认地址。本期不挂发货/入库单据字段（预留取默认地址的能力即可）。

## User Stories

1. As a 销售内勤, I want 在客户抽屉里直接新增/编辑/删除收货地址, so that 不用先去独立地址页
2. As a 采购内勤, I want 在供应商抽屉里维护取货/办公地址, so that 与客商维护动线一致
3. As a 管理员, I want 在公司抽屉里维护本公司作为内部公司对手时的地址, so that 集团往来有地点档案
4. As a 用户, I want 给同一客户挂多个收货地址并标一个默认, so that 建单时能选默认
5. As a 用户, I want 地址可停用而不必删除, so that 历史引用将来不丢（本期无单据引用，停用拦新选用）
6. As a 用户, I want 删除客商/公司时地址一并清掉, so that 无孤儿行
7. As a 用户, I want 新建主体尚未保存时提示「先保存再维护地址」, so that 从属关系清晰
8. As a 系统, I want 地址不跨主体共享同一行, so that 与客商分表模型一致
9. As a 系统, I want 不设独立地址菜单, so that 不诱导「先配地址库」
10. As a 系统, I want 发票地址电话与仓址本期不动, so that 范围可控

## Implementation Decisions

### 数据模型

- 表 `bas_party_address`：
  - `party_type` + `party_id`（多态，无真外键；类型限 `CUSTOMER` / `SUPPLIER` / `COMPANY`，与 Party  wire 一致）
  - `name`（地址名称，必填，主体内不必唯一）
  - `purpose`：`SHIPPING` | `OFFICE` | `OTHER`（收发货 / 通信办公 / 其他）
  - `contact_name`、`contact_phone` 可空
  - `address`（详细地址自由文本，必填；省市区写进正文，不建行政区划主数据）
  - `is_default` 布尔，默认否
  - `active` 布尔，默认是
  - `remarks` 可空
  - 时间戳
- 部分唯一：同 `(party_type, party_id, purpose)` 下至多一条 `is_default = true`（部分唯一索引）
- 保存时若新默认=true，同事务清掉同主体同用途其它默认
- 删除主体：应用层按 `party_type+party_id` 级联删地址（多态无 DB 外键）

### 权限与资源

- 资源 `basPartyAddresses`，权限前缀 `base.party_address`（标准 CRUD）
- **无菜单项**；列表 API 存在，供主体抽屉与将来选址器使用
- 内置 sales 角色种子补 `base.party_address:*` 四码（与客户维护同权）
- 审计 resource 码 `bas_party_address`

### API

- `POST /api/v1/base/party-addresses/query` 列表（可按 partyType/partyId/purpose/active 筛）
- `POST /api/v1/base/party-addresses` 创建
- `GET|PATCH|DELETE /api/v1/base/party-addresses/:id`
- 创建/更新校验主体存在；`party_type`/`party_id` 创建后不可改（换主体=删重建）

### 前端

- 客户 / 供应商 / 公司抽屉 `extraContent`：地址区段（列表 + 二级抽屉增改 + 删 + 默认徽标 + 停用）
- 主体 create 模式：仅提示先保存
- 不新增路由/菜单

### 非目标（本期）

- 销售发货/采购入库头挂地址字段与快照
- 发票购销方地址电话结构化
- 仓库/外协仓物理地址
- 员工现住址迁入本表
- 跨主体共享同一地址行
- 国家行政区划主数据 / 级联选择器

## Acceptance

- [x] 客户/供应商/公司抽屉可完整 CRUD 地址
- [x] 同主体同用途仅一个默认；设新默认自动顶替旧
- [x] 无独立地址菜单
- [x] 删主体后地址无残留
- [x] 权限码出现在权限目录；sales 种子含地址四码
- [x] 集成测试覆盖 CRUD / 默认唯一 / 主体校验 / 级联删
- [x] `CONTEXT.md` + 基础资料产品文档 + ADR 已同步
