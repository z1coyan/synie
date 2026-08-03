# 01 — 表结构、资源 meta、地址服务与 API

Status: ready-for-human

## Scope

- 迁移 `bas_party_address` + 默认地址部分唯一索引
- `basPartyAddresses` ResourceMeta / classification / 权限
- AddressService：CRUD、主体存在校验、默认顶替、审计
- REST `/api/v1/base/party-addresses`
- 客户/供应商/公司删除时级联清地址
- sales 角色种子补权限
- PG 集成测试

## Out of scope

前端 UI、产品文档（见 02、03）
