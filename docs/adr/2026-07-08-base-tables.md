# ADR：基础主数据表（公司 / 单位 / 货币）

2026-07-08。基础主数据统一 `bas_` 前缀（区别系统表 `sys_`）。

- **公司** `bas_company`：code 两位英文字母、手填、创建后不可改。
- **单位** `bas_unit`：按类型（length/area/weight/quantity），每类型至多一个基准单位（ratio=1），其余 ratio 折算到基准；symbol 全局唯一。单位/货币全局、不挂公司。
- **货币** `bas_currency`：ISO 三位大写、创建后不可改。权限前缀 `base.unit` / `base.currency`。
