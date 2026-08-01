# ADR：Convex 资源查询轮廓与游标型 ResourceBinding

2026-07-31，状态：已实施（资源面竖切阶段）。本 ADR 固定通用资源从 SQL 查询模型切换到
Convex 的形状，并以货币、计量单位、仓库三个资源完成真实 self-hosted 验收；其余资源按事务
闭包沿用相同边界迁移。

## 背景

旧资源列表接受任意列筛选、任意排序，以 SQL `count(*) + limit/offset` 实现。Convex 的有效查询
要求索引先行、使用 cursor pagination，扫描后 `.filter()` 不仅性能不可控，也会把被过滤文档计入
事务读取预算。若把旧 DSL 原样翻译，会把数据库差异泄漏到每个页面并产生隐蔽全表扫描。

Resource Catalog 已经是字段、权限、表单和能力声明的事实源，ResourceBinding 也已把页面与具体
transport 隔离，因此查询能力应在这两个深模块内一次收口，而不是由页面选择 REST 或 Convex。

## 决策

### 查询只接受预声明轮廓

每个 Convex 资源声明有限的 Resource Query Profile。轮廓固定 key、等值前缀、至多一个范围字段、
排序方向、search index、公司范围和可选权威计数；seal 阶段将 Catalog 声明与 schema index registry
逐项对拍。函数参数使用白名单 validator，无法解析到一个轮廓的筛选/排序组合 fail-closed，前端显示
「此组合暂不支持」，绝不回退 `.filter()`、无索引 collect/take 或动态表查询。

三个首批资源采用：

- 货币：按 ISO 的 `default`、启用状态 `lookup`、全文 `search`；
- 单位：按名称的 `default`、单位类型 `lookup`、全文 `search`；
- 仓库：公司内 `default`/`lookup`、公司加父节点的 `treeChildren`、公司内全文 `search`。

架构测试禁止 `convex/resources/**` 出现 `.filter()`，并禁止列表绕过 `.withIndex()` /
`.withSearchIndex()`。公司范围和权限由服务端 Actor 在每次调用重新校验；Catalog 的能力/命令投影
只控制呈现，不替代 mutation 鉴权。

### ResourceReader 只暴露不透明 cursor

统一页形状为 `results + pageInfo { continueCursor, isDone } + optional totalCount`。Reader 输入为
`profile + numItems + opaque cursor + profile args`。Grid 维护 cursor stack 实现前后页；卡片和远程
选择器按 cursor 追加；CSV 循环到 `isDone`，发现 cursor 重复立即中止。缓存键包含资源、轮廓、规范
参数与 cursor，不含函数名或 transport id。

资源查询的统一单页上限是 100；业务组件声明的 200 等数值只表示总拉取上限，runtime 必须按至多
100 条跟随服务端 opaque cursor 聚合，不能直接放大 `numItems`。仍依赖 `limit/offset` 的前端组件只可
经中央兼容 adapter 重放真实 cursor 并在本地跳过 offset；adapter 自己的 synthetic offset cursor
不得传入 Convex。父单、公司等固定范围也必须在每一页保持，无法归一为单值的范围筛选 fail-closed。

没有受控 counter 的查询不返回精确总数，界面不推算总页数。迁移期 legacy 模式只有一个中央
adapter 将 cursor 编码为 offset，并把 SQL count 映射为 `totalCount`；Plan 008 删除该 adapter。
页面和通用组件从此不知道 offset。

### 复合业务候选使用服务端命名投影

订单履约、对账、报销挂票、报价有效期等选择器不把旧 REST FilterState 翻译成动态查询。Web 适配器
必须把完整旧筛选归一成 `candidateProfile + profile args`；服务端再次逐项验证参数集合、类型、公司范围与
固定资格，缺项、额外字段和未知 profile 均 fail-closed。候选资格与单据写入在同一 mutation 内重建到
`domainCandidateRows`，普通读取只使用 `resource + profile + canonical key + sortValue` 复合索引，搜索也
必须在 search index 中保持相同三段 filter key。

报价的 `quotationDate <= orderDate <= validUntil` 使用固定日期域的 segment-tree 区间投影：写入把区间
分解为至多 O(log N) 个 canonical node，点查询使用祖先 node，并在服务端按 profile 固定排序合并；不做
内存 post-filter。多 key 普通分页 cursor 保存最后一个服务端 sort key，多 key 搜索 cursor 保存当前
segment 与原生 search cursor；两者都绑定资源、profile、完整 key 集和搜索词指纹，不能跨查询重放。

费用报销发票的「一票一单」同时由候选反向引用投影和写入前 `domainReferences.by_target` 事务断言保证；
损坏引用一律视为已占用。旧实例通过超级管理员认证的 `candidateRepair:rebuildPage` 分页重建 finance、
trading、manufacturing 三个 closure store；旧报价行与委外用料行缺少受控快照时，从权威父单回溯，避免
repair 只覆盖新代码写入的数据。

### 值类型与约束保持业务口径

Convex document ID 作为不透明非空 string 进入前端，不伪装 UUID。日期使用 canonical
`YYYY-MM-DD`，datetime 使用 UTC epoch milliseconds。所有金额/数量 wire 继续使用非科学计数法
十进制字符串；存储采用按字段证明范围的 scaled `int64`，统一 half-up，精度仍为 2/4/6 位，输出
去除无意义尾零。

Resource Catalog 只声明字段、轮廓和命令；create/update/delete、唯一性、引用、树和 seed 原子性
仍由显式领域 mutation 负责。仓库的「初始化默认仓库」是需要 create 权限的 collection command，
三行仓库与审计占位在同一 transaction；正式审计账在 Plan 004 替换占位表。

### 迁移期写权威按进程模式唯一

`legacy` 进程的三个资源仍只写 REST/PostgreSQL，`convex` 进程只注册三个 Convex binding；未知资源
和路由 fail-closed，不做双写、跨后端 transaction 或逐请求 fallback。机器清单覆盖 105 张旧表、
100 个 Catalog 资源和 148 个 numeric 字段，并记录每种模式的唯一 writer authority。

## 否决方案

- **在 Convex 中复刻任意 SQL filter/sort/count**：需要扫描，无法给出稳定预算与索引保证。
- **把函数引用直接写进页面**：会破坏 ResourceBinding seam，让后续 transport/缓存变化扩散。
- **继续以 UUID 校验资源 ID**：Convex ID 是 opaque，伪 UUID 会建立第二身份并污染外键。
- **让 Catalog 生成通用 CRUD mutation**：声明无法表达领域事务、引用与删除保护。
- **每页都计算 exact count**：没有受控 counter 时成本和一致性都不成立。

## 验证证据

- manifest 对拍 105/105 SQL tables、100/100 resources、148 numeric columns，零未解释、零重复
  writer；三个试点标记 `convex-verified`。
- 真实隔离 self-hosted PostgreSQL 17 + MinIO + Convex deployment 中，20 个并发相同 ISO 创建仅一笔
  成功；cursor 连续无重漏，search/lookup/treeChildren 均命中声明索引。
- 币种/单位/仓库 CRUD、定点小数、唯一/FK/引用删除、树父节点和公司范围约束均由服务端验证；
仓库两个 seed 故障点均证明三仓与正式审计完全回滚，正常 seed 幂等；Plan 004 已将三项 pilot 的
占位 hook 切换到 `auditLogs`，递归过滤敏感值并对超大变更同步写摘要。
- 只读 Actor 的 Catalog 不含写能力或 seed command，直接 mutation 和越权公司 query 仍由服务端拒绝。
- Chromium 完成 setup、三个页面、货币创建/搜索/刷新、仓库幂等 seed、受限账号重登；网络无
  `/api/v1` 请求。legacy ResourceBinding interface、Grid、Drawer、remote select 与 CSV 回归通过。

## 后果

- 新增筛选/排序能力必须先设计查询轮廓与索引，再开放 UI；产品不能以任意组合为默认假设。
- 可选总数会使部分列表不显示精确总页数，这是明确的产品行为，而非加载错误。
- 后续迁移资源复用同一 cursor、Catalog seal、Actor 和领域 mutation 形状；Plan 008 最终删除
  cursor→offset adapter、REST registry 与双模式开关。
