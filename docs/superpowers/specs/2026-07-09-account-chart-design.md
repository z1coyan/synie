# 会计科目表设计

2026-07-09。方案经用户确认:科目直接挂公司(ERPNext 式),不做独立"科目表"实体。

## 后端

- `SynieCore.Base.Account`,表 `bas_account`;每公司一棵科目树,`[:company_id, :code]` 唯一。
- 会计要素本身是科目(根节点 `parent_id` 为空),由模板决定要素个数,不写死类别枚举。
- 字段:code/name/direction(借贷枚举)/is_group(汇总科目,暂只存不管记账)/active/parent/company(必填,创建后不可改)/currency(可选)。
- `children_count` 公开聚合,供前端树形懒加载判断展开箭头。
- 校验:上级科目不能是自身、必须同公司;有下级不能删;成环检测与 Company 一样留跟进。
- 模板初始化:泛型动作 `init_from_template(company_id, template)`,事务内整套建账,公司须无科目;模板数据在 `SynieCore.Base.AccountTemplates`(cas 企业会计准则 6 要素/small 小企业会计准则 5 要素/intl 国际精简 5 要素),GraphQL mutation `initBasAccountFromTemplate`。
- 权限 `base.account`(含 `init_from_template`);多公司 fail-closed 照 CompanyScope/CompanyAccessible 既有机制。

## 前端

- SynieDataGrid 新增 `tree` prop:**懒加载**——初始只查根层(`parentId isNil`),展开时按 `parentId eq` 拉子层,每层上限 200;`childrenCount>0` 显示箭头;不拉全量。
- tree 模式隐藏分页、禁用列排序;用户输入搜索/筛选时自动退回平铺分页模式。
- 新增 `fixedFilter` prop:恒定并入查询条件,不进筛选 UI(科目页用它做公司过滤)。
- 科目页 `/base/accounts`:顶部公司选择器;空科目公司显示"从模板初始化"空态;增删改查走既有 RecordDrawer/RemoteSelect fk 机制。

## 不做(YAGNI)

科目表头表、成环检测、记账校验、多级编码自动拼接、合并报表、RemoteSelect 按公司过滤候选(靠后端校验兜底)。
