# ADR：SynieDataGrid 查询状态同步到 URL search

2026-08-02，状态：已实施（组件内核 + 物料页试点；内嵌点位与边缘页见工单）。

关联：

- 本决策 slug：`url-grid-state`
- 并行：`url-record-drawer`（记录抽屉 open/mode/id 入 URL）
- 并行：`route-loader-prefetch`（路由 loader 预取与 search 对齐）

## 背景

列表的搜索、列筛选、分页、排序原先全部活在 `SynieDataGrid` 的 `useState` 里：刷新丢失、无法分享筛选视图、浏览器历史不经过查询状态。全站列表路由几乎没有 `validateSearch`；若要求每个路由声明 search schema 才能同步，迁移面过大。

同时，记录抽屉 URL 化、路由 loader 预取两条工作线会与网格共用同一 search 对象，必须事先划清键空间与更新语义。

## 决策

### 1. 机制内置在 SynieDataGrid，路由零契约

- Hook：`useUrlGridState`（组件目录）+ 纯函数编解码 `~/lib/url-grid-state`
- 读取：`useSearch({ strict: false })`，不强制 `validateSearch`
- 写入：`navigate({ search: (prev) => mergeGridUrlSearch(prev, patch) })`，**禁止**整包替换 search
- 页面级默认开启；`pick` 选择器默认关闭；其余内嵌显式 `urlState={false}`

### 2. 键空间与默认值省略

| 键 | 含义 | 省略条件（无参 = 与旧默认一致） |
|----|------|----------------------------------|
| `q` | 搜索词 | 空串 |
| `page` | 页码 | `1` |
| `ps` | 每页条数 | `20` |
| `sort` | 排序 | 等于 `defaultSort` 或（无 default 时）无排序；用户清除有 default 的排序时写 `none` |
| `f` | 筛选（紧凑 DSL） | 空且无 `defaultFilters`；有 default 时用户清空写 `{}` |

`f` 使用紧凑 DSL（非 JSON），读写在 `~/lib/url-grid-state`：

| 形态 | 示例 |
|------|------|
| text contains（默认、最短） | `code~1` |
| text 其它 op | `code~eq~A-1` / `code~nc~x` |
| bool | `active~b~1` |
| enum / enumArray | `status~e~DRAFT,AUDITED` / `tags~a~A,B` |
| number / date | `qty~nb~1,10` / `day~d~2026-08-01` |
| fk / polyFk | `companyId~f~u1:甲公司` / `partyId~p~CUSTOMER~c1:客户甲` |
| 多条件 | `code~1;active~b~1` |

值内 `~ ; , : \` 反斜杠转义。旧 JSON 书签（`f` 以 `{` 开头）仍可读。Chips 所需的 fk `labels` 仍进 URL，保证恢复后可读可改可清。

### 3. 与另外两个 slug 的边界

| 能力 | 拥有的 search 键 | 更新规则 |
|------|------------------|----------|
| **url-grid-state** | `q` `page` `ps` `sort` `f` | 只 patch 上表键 |
| **url-record-drawer** | `record` `mode`（以该 ADR 定稿名为准） | 只 patch 抽屉键；不得 `search: { record }` 抹掉网格键 |
| **route-loader-prefetch** | 不新占键；读取网格键以对齐预取 queryKey | loader 内复用 `parseGridUrlSearch`，与客户端首屏一致 |

三者兼容约定：

1. 任意一方更新 search 必须 `old => ({ ...old, ...patch })`（或等价 merge），**永不**整包字面量替换。
2. 键名互斥；新增全局 search 键前先查本 ADR 与抽屉 ADR。
3. 内嵌网格 / 选择器永不写 URL，避免与页面主列表或抽屉状态串味。
4. prefetch 不得发明第二套筛选序列化。

### 4. 试点与推广

- 试点：`web/app/routes/_app/scm/materials.tsx`（默认开启，无 validateSearch）
- 内嵌关闭清单与 market/entries 边缘验收见 `.scratch/url-grid-state/issues/`

## 备选方案

- **每路由 validateSearch + 页面受控状态**（拒）：100+ 路由重复样板，FilterState 富对象难进 zod，与「组件收敛」方向相反。
- **sessionStorage / 全局 store 记筛选**（拒）：不可分享、多标签不一致、无浏览器历史。
- **仅同步 search 文本、不同步筛选**（拒）：列筛选才是 ERP 列表的主查询条件。
- **JSON 同构落 f**（已弃）：`code contains 1` 即膨胀为整段 URL 编码 JSON；改为紧凑 DSL 后同类条件约 `f=code~1`。
- **压缩二进制 / base64 单参数**（拒）：不可读、不可手改；DSL 已够短且人类可读。

## 后果

- 多条件 + 多 fk labels 时 `f` 仍会变长，但远短于 JSON；`labels` 换可读 Chips，不省略。
- 存量 `navigate({ search: { tab } })` 一类整包写入会抹掉网格键——边缘工单要求改为 merge（`market.tsx` 优先）。
- 未打 `urlState={false}` 的非 pick 内嵌网格会暂时写 URL（已知：银行导入抽屉、对账抽屉列表）；须在 issue 04 收口。
- 同页双主网格争用同一键空间：罕见，争用时只留一个启用 URL。
- 产品文档 / `CONTEXT.md` 本轮不改（纯前端基建）；术语若进入用户可见「分享筛选视图」文案时再补。
