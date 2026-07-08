# 基础表:公司 / 单位 / 货币

- 基础主数据表统一 `bas_` 前缀(区别于系统表 `sys_`)。
- 公司 `bas_company`:code 两位英文字母、手动输入、创建后不可改;name、short_name 必填。
- 单位 `bas_unit`:unit_type 枚举 length/area/weight/quantity;symbol 全局唯一(如 pcs、kgs);每类型仅一个基准单位(部分唯一索引),基准单位 ratio=1,其余 ratio>0 为换算到基准单位的比例(kg 基准时 g=0.001)。
- 货币 `bas_currency`:iso_code 三位大写字母(ISO 4217)、唯一、创建后不可改;symbol 可选。
- 单位/货币是全局主数据,不挂 company_id;权限前缀 `base.unit`、`base.currency`,动作 CRUD 四项。
- GraphQL 沿用系统小表约定:扁平列表查询 + create/update/destroy 变更。
