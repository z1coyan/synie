# ADR：记录抽屉 URL 化

2026-08-02，状态：已实施（BOM 试点）。关联：

- [`url-grid-state`](./2026-08-02-url-grid-state.md)（Grid 搜索/筛选/分页入 URL）
- [`route-loader-prefetch`](./2026-08-02-route-loader-prefetch.md)（路由 loader 预取）
- 规格：[`.scratch/url-record-drawer/spec.md`](../../.scratch/url-record-drawer/spec.md)

## 背景

页面级 `SynieRecordDrawer` 长期由 `useState` 持有 `{ mode, row }`。地址栏只有列表路由，导致无法深链分享单条记录、刷新丢抽屉、前进后退不经过抽屉态。FkPreview 全局速览同属状态驱动，但与页面主抽屉的寻址语义不同（叠层、资源键），本轮不合并解决。

同期还有两条前端 URL/数据基建线：Grid 状态入 URL、路由 loader 预取。三者必须约定 search 键与更新方式，避免同页互相覆盖。

## 决策

### 1. search 契约

| 参数 | 含义 |
| --- | --- |
| `record=<uuid>` | 打开既有记录；配合 `mode` |
| `mode=view\|edit` | 仅在有 `record=<uuid>` 时有效；缺省/非法 → `view` |
| `record=new` | 新建；忽略 `mode`，序列化时不写 `mode` |
| 无 `record` | 关闭；单独 `mode` 不构成状态 |

### 2. 可复用 hook，而非改 Drawer 组件本体

`useRecordDrawerUrl(resource, { enabled? })` 放在 `web/app/lib/`：

- 读：`useSearch({ strict: false })`，路由无需 `validateSearch`
- 写：`navigate({ search: prev => ({ ...prev, ...patch }) })`，**函数式、保留未知参数**
- 初始行：`resourceBindingFor(resource).reader.get` + `cache.rowKey(id)`（与 Drawer 内 rowId 自查同键）
- `enabled: false`：不读不写 URL、不发查询（共享 Provider 在非列表宿主关闭同步）

页面把 `recordId` 交给 `SynieRecordDrawer` 的 `rowId`；加载中 / 不存在 / 403 复用组件已有 QueryState/EmptyState，不在 hook 内再造一套 UI。

### 3. 历史语义

- `open`：压栈（后退 ≈ 关抽屉）
- `setMode` / `close`：`replace: true`（view↔edit、关抽屉不堆历史）

清参时把键置 `undefined`；router-core `encode` 跳过 `void 0`，等价删除 query key。

### 4. 试点与边界

- **本轮实现**：`mfg/boms` 列表 `BomDrawerProvider urlSync`；工单内嵌 BOM 默认 `urlSync={false}`
- **本轮不做**：FkPreview URL、其余列表页全量迁移、聚合 draft 深链专项（见 `.scratch/url-record-drawer/issues/`）

### 5. 与另两条线的边界

| 能力 | slug | 职责 | search 键（约定） |
| --- | --- | --- | --- |
| Grid 状态 | `url-grid-state` | 列表搜索/筛选/分页/排序 | 自有前缀或约定键（如 `q`/`page`/筛选序列化） |
| 记录抽屉 | `url-record-drawer` | 单条 view/edit/create 抽屉 | **仅** `record`、`mode` |
| loader 预取 | `route-loader-prefetch` | 导航 intent 预取 Query 缓存 | **不写** search；复用 `resourceBindingFor().cache` 键 |

兼容铁律（三线共用）：

1. **search 更新一律函数式** `prev => ({ ...prev, ... })`，禁止 `search: { ...新对象 }` 整包替换。
2. **未知参数原样保留**——Grid 不碰 `record`/`mode`；抽屉不碰 Grid 键；loader 不写 search。
3. **缓存身份统一** `resourceBindingFor(resource).cache`，禁止手写 `gridRows`/`rowById`。
4. 路由 **不强制** 为抽屉/Grid 声明 `validateSearch`（松散读）；与 loader 预取正交。

## 备选方案

1. **path 段 `/boms/$id`**：RESTful，但与全站「列表 + 抽屉」信息架构冲突，且 create/edit 要额外子路由；否决。
2. **改 SynieRecordDrawer 内建读 URL**：组件与路由耦合，内嵌抽屉/FkPreview/EditableTable 误写 URL 风险高；否决。选页面/Provider 显式接 hook。
3. **只用 hash（`#record=`）**：不进服务端、难与 Grid search 统一；否决。
4. **每个路由手写 validateSearch + 本地 state 同步**：样板重复且易与 Grid 整包替换互踩；否决。

## 后果

- **正向**：单条记录可分享、可收藏、可刷新；迁移路径清晰（换 hook / 开 `urlSync`）。
- **负向**：URL 成为 UI 状态源之一，测试需覆盖 parse/patch；共享 Provider 必须显式区分列表宿主与内嵌宿主。
- **后续**：全站列表迁移（issue 03）、FkPreview URL（issue 04）、聚合 draft 深链（issue 05）；与 `url-grid-state` 合并到同页时只依赖函数式更新约定，无需再协调键名以外的协议。
