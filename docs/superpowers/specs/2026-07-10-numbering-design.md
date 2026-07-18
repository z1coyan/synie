# 自动编号模块设计(v2)

日期:2026-07-10(v2 依据用户评审重构:去掉重置周期、规则显式绑定资源、段组装式规则编辑)

## 定位

- 通用单据自动编号:规则显式**绑定资源**(单据),规则内容是**有序段列表**(固定文本 / 记录字段 / 序号),页面点选组装,不写模板字符串。
- 首个接入方:手工会计凭证 `acc_gl_journal`。凭证编号留空自动取号,手填仍可用。

## 数据模型

域 `SynieCore.Numbering`(目录 `numbering/`,权限域 `sys`)。两张表:

### sys_numbering_rule(编号规则)

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `resource` | 绑定资源,非空;取值为资源权限码前缀(如 `acc.gl_journal`),前端下拉只列已接入 AutoNumber 的资源 |
| `name` | 规则名称,非空 |
| `segments` | jsonb 有序段列表,非空;段形态见下 |
| `per_company` | 是否按公司计数(计数 key 追加公司编码维度),默认 true |
| `enabled` | 启用,默认 true;**每资源至多一条启用规则**(应用层校验 + DB partial unique index 兜底) |

段形态(map,string key;`label` 为前端展示冗余,后端忽略):

- `{"type": "text", "value": "记"}` — 固定文本,非空
- `{"type": "field", "field": "date", "format": "YYYYMM"}` — 记录字段;`field` 支持本资源属性(`date`)与 belongs_to 一级字段(`company.code`);date/datetime 字段必须带 `format`(YYYY/YY/MM/DD 组合)
- `{"type": "seq", "padding": 4}` — 序号,**恰好一个**,padding 0..12(0=不补零)

校验(`ValidateSegments`):非空、恰一 seq、text 非空、field 路径在绑定资源上可解析、format 合法。

- 权限码 `sys.numbering_rule`,actions `create read update delete`;接审计;segments 经 GraphQL 走 `json_string`(同审计 changes 先例)。

### sys_numbering_counter(编号计数器)

同 v1:`rule_id` + `scope_key` + `value`,unique (rule_id, scope_key),只开 read/update(页面调当前值,走 Ash 有审计),行由取号 upsert 自动创建,复用 `sys.numbering_rule` 权限码。

**计数 key(v2 核心简化,无重置周期)**:

```
scope_key = (per_company ? 公司编码 <> "|" : "") <> 渲染后的非 seq 段拼接文本
```

如 `记JT-202607-{seq}` 的 key 为 `JT|记JT-202607-`。月份变了 key 自然变、序号自然从头计——重置语义由段里引用的日期格式隐含,无需独立配置。

## 取号

`SynieCore.Numbering.next(changeset)`:

1. 按 `changeset.resource.permission_prefix()` 查启用规则,无 → `{:error, :no_rule}`
2. 逐段渲染(field 值从 changeset 取;belongs_to 一级字段 DB 反查;缺值报"编号字段 X 无值")
3. 算 scope_key → PG upsert 原子递增(同 v1)→ 序号补零嵌回段位置

`AutoNumber` change(opts 仅 `attribute:`):create 构建期目标属性为空则调 `next/1` 填充(必填校验时机同 v1,跳号可接受)。

## 绑定关系(用户评审点 2)

- 规则列表首列即绑定资源(中文标签,复用 permission-labels)。
- GraphQL `numberableResources` 返回已挂 AutoNumber 的资源清单 `[{prefix, grid}]`(反射 create action changes),前端资源下拉只列这些——建规则即绑定,启用即生效。
- 新单据接入 = create action 挂一行 `change {AutoNumber, attribute: :编号字段}`,自动出现在下拉里。

## 前端

`/system/numbering`:

- 表格列:资源(中文)、名称、规则预览(段渲染示例)、按公司计数、启用。
- 抽屉:资源下拉(创建后不可改)、名称、**段组装器**、两开关;计数器子表同 v1(只改值)。
- 段组装器(SegmentsEditor):已选段 chips(可删);添加固定文本(输入框)/字段(下拉,候选来自绑定资源 gridMeta;fk 字段二级选择目标字段;日期字段选格式)/序号(位数,已有则禁用);实时预览。字段候选与外键目标字段全部由后端 gridMeta 反射,用户零模板语法。

## 已补

- 字段段空值省略(见 ADR 2026-07-18-numbering-omit-and-padding)
- 序号 padding 0 不补零
- 段拖拽排序(前端 SegmentsEditor)

## 范围外(跟进项)

- 序号空洞回收/预占
- 其他单据接入(挂同一 change 即可)
- 段级 omit 开关(当前一律空则省略)
