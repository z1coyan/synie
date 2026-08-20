# Synie

项目使用 TanStack Start + HeroUI + **Bun/Hono REST**（`@synie/server` hono/client + ResourceBinding/ResourceTransport）为产品技术栈。不引入 GraphQL / OpenAPI codegen。

## 项目守则

- 前端所有非幂等请求都要有回馈，使用Hero UI的Toast作为反馈组件
- 所有请求均要进行错误处理，有合适的报错信息方便排查
- 尽可能使用组件库已有的组件进行开发而不是自己使用html+tailwindcss搭建
- 表单/筛选控件一律用 HeroUI(Pro) 现成组件（日期用 DatePicker/DateRangePicker、数值用 NumberField、下拉用 Select 等），不要包装浏览器原生 input；有已封装的业务组件时优先复用业务组件
- 业务数据请求走 `~/lib/api`（hono/client）或 `~/lib/resources` registry；禁止新增 GraphQL / `gqlFetch` / openapi-fetch 路径
- 生产页面的 `SynieDataGrid` / `SynieRecordDrawer` / 远程选择器只传 `resource`，由 `ResourceBinding.reader` 解析规范生产 Adapter；不要显式传 `client`。显式 Adapter 只用于 custom/in-memory 局部读模型与 interface 测试。列表与单条缓存键、失效一律经 `resourceBindingFor(resource).cache`，不得手写 `['gridRows', ...]` / `['rowById', ...]` 或依赖 transport id。
- 资源 transport 一律用 `restTransport(resource, api..., options)` 工厂（`~/lib/resources/rest-transport.ts`）：标准五方法、严格列表、decimal/datetime 字段、能力子集都走 options；只有偏离标准形状（单例、非 `:id` 读取路径、封闭创建集合等）才手写或 `{...restTransport(...), create(...)}` 组合覆盖，并标注「偏离标准形状」注释。不要新增逐方法手写的资源 client 样板。
- 聚合草稿 Adapter 一律用 `aggregateDraftTransport(api..., { wire? })` 工厂（`~/lib/resources/aggregate-draft-transport.ts`）：GET `:id/draft` / POST / PUT `:id` 三连；领域 wire（decimal、集合显式性）经 `options.wire` 注入。不要新增逐资源手写三方法样板；测试可注入 gateway 的资源保留薄包装（如 `createSalesDeliveryDraftAdapter`）。
- 子行 diff 持久化（删缺失→建新增→改变更）一律用 `persistChildRows` / `rowChangedByKeys`（`~/lib/resources/persist-child-rows.ts`）：COMPARE_KEYS 与 itemChanged 进工厂参数，页面只保留 `inputOf`/父键/错误 `rowLabel`/`skipDelete`。不要再手写三阶段循环；已有整单 `replaceDraft` 的资源继续走聚合 Adapter，勿回退到逐行 diff。
- 页面消费 binding 写能力一律 `requireWriter(binding, 'create' | 'update' | 'delete', 中文标签)`，不再写 `in` 收窄或 `if (!binding.writer) throw` 守卫。
- Vite 仅代理 `/api/v1` → Bun server（`SYNIE_API_PORT`/`GO_API_PORT`，默认 8080）；认证为 httpOnly cookie 会话（better-auth，`~/lib/auth-client`），不得往 localStorage 存凭证

## 业务数据页标准组件

- 业务面（`_app` 壳、列表、抽屉、筛选）默认高密度：按钮 `size="sm"`，表单控件用 Tailwind 收到 sm 高度（HeroUI v3 字段无 size）；登录、初始化向导、启动幕布等仪式面除外。
- 数据列表一律用 `SynieDataGrid`（`~/components/synie-data-grid/`）；数据详情、新增、编辑一律用 `SynieRecordDrawer`（`~/components/synie-record-drawer/`）三态抽屉，不要自造表格或表单。
- 列表筛选用工具栏「筛选」加法器 + 条件标签，不要在列头放漏斗。
- 表格列名与表单字段标签只写简短、明确的业务名称（如「数量」）；不得把正负方向、单位口径、计算规则等说明塞进名称（如「数量(带符号,入正出负,物料默认单位口径)」），这些说明应放在页面说明、帮助文案或产品文档中。
- `form.kind=basic` 的必填、只读、标签、枚举、外键与静态布局由服务端 Resource Catalog 声明，页面通过 `useCatalogBasicForm` 消费，不得重复手写。复杂资源的条件显隐、effects、React input/render、附件和子表属于 Presentation Extension，才在共置模块或页面叠加 `fields` override；接入范例见 `routes/_app/system/roles.tsx`。
- 「保存并审核」是所有表单的通用约定：资源 meta 下发 `audit` 扩展动作且当前用户具备 audit 权限时，`SynieRecordDrawer` 会在「保存」旁自动出现「保存并审核」按钮（仅草稿单），页面无需自绘；前提是 `onSubmit` 返回保存后的记录 id（create 态必须 return 新 id，否则只能保存不能自动审核）。审核确认统一用列出整单条目的核对弹窗（`routes/_app/scm/-audit-doc.tsx` 的 `useAuditDoc`，条目页行操作「审核整单」与单据页「审核」共用），不要再用只显示条数的通用确认框。
- 领域命令若会改变关联资源，必须在对应 `CommandSpec.affectedResources` 旁声明；当前资源与系统审计日志由统一失效实现自动补入。所有 row/bulk/rowOrBulk/collection 命令一律经 `executeCommandWithInvalidation` 先解析完整 effects、再执行并精确失效；单记录场景可用 `executeSingleRowCommandWithInvalidation` 便利入口。不得在页面手拼查询键、另维护依赖清单或遍历全部 ResourceBinding 全局失效。
- 启用/停用等状态类开关不进创建/编辑表单（表单 `exclude` 掉，新建由后端默认值兜底）：状态翻转用独立入口（表格行动作、详情页按钮）显式触发；仅记录固有属性的布尔（如叶子分类、基准单位）仍属表单字段。
- 父表单内的子条目（单据行、明细行等）一律用 `SynieEditableTable`（`~/components/synie-editable-table/`）：表格纯展示，增改一律走二级 `SynieRecordDrawer`，不做行内编辑；`items`/`onChange` 受控、组件不发写请求，父表单提交时一并持久化，新增行 id 带 `local:` 前缀（`isLocalRow` 判别）。
- 表头与子条目共同构成业务聚合时，父表单经该业务模块的 `AggregateDraftAdapter` 整单读取/创建/替换；后端必须在领域事务内保存完整草稿，多 SELECT 的 load 使用一致读快照，replace wire 必须显式提交全部集合/嵌套子树并按实际差异保留原有 create/update/delete 授权。禁止在页面或通用 Catalog 中循环 create/update/delete 并把它描述为原子保存。
- **单据抽屉骨架**：带明细的单据抽屉（发货/入库/对账/订单/报价/BOM、库存出入库/盘点/调拨、报销/凭证/发票/工艺模板等）一律经 `useDocumentDrawer`（`~/lib/use-document-drawer.ts`，`docs/术语表.md` 术语「单据抽屉骨架」）承载管道——urlSync/本地双态、URL 身份→整单草稿装载（竞态安全）、深链补拉、装载失败与非法 id 呈现（toast 文案从资源文档标签自动派生，可 `loadErrorLabel` 覆盖）；禁止再手写 `reqIdRef`/`loadedIdRef`/`useRequestGuard` 竞态守卫、深链补拉 effect 或 `urlSync ? ... : localDrawer...` 三元。共享抽屉的 open 桥（createContext + useXxxDrawer + Provider）一律 `createDocumentDrawerOpenBridge<OpenXxx>()`，不要再手搓 Context 三件套。骨架只收管道：条目状态、条目编辑 UI、科目联动、快照回填与 onSubmit 仍属各抽屉。约定：`loadDraft` 保持纯函数（聚合草稿直接委托 `aggregateDraftFor(...).loadDraft`；多子表用 Promise.all 组装，预热结果装进 draft 返回，不在 await 之间写 ref/state）；条目初始化走「drawer.draft 派生 effect」，依赖必须是 `[drawer.draft, drawer.generation]`（generation 覆盖 create/关闭时 draft null→null 引用不变也需重置的场景）；openDrawer 的额外参数（如 BOM 的 options）保持本地 state，不进骨架。
- 组件能力不够时先扩组件再用，不要在页面里绕过它手搭。
- 外键单元格/字段默认渲染为可点 link，点击开全局速览抽屉（`FkPreviewProvider` 已挂 `_app` 布局，页面零接线）；资源解析经 `resourceBindingFor`，Meta 经 ResourceDocument。页面 Basic Form 用 `useCatalogBasicForm`；Presentation Extension 的 Drawer / audit / document preview implementation 与对应业务模块共置，全局 registry 只做薄装配且未知资源 fail-closed。
- **物料列**：所有用到物料的表格（DataGrid 列表、SynieEditableTable 子条目、审核确认弹窗等只读/半只读表格）一律用统一物料单元格（`~/components/synie-material-cell/MaterialCell`）：保留 `materialCode` 列并 override 为 `materialCellRender({ drawingOwnerType? })`（label「物料」、DataGrid 上 `mobileRole: 'title'`、`filterField: 'materialId'`——快照行的列筛选仍按物料外键走 fk 选择器，不做编号文本筛选），撤掉 `materialName`/`materialSpec`/`customerPartNo` 独立列（撤列后经 `extraFields` 继续取回这三个字段与 `materialId`）。单元格形态为「图纸缩略图 + 编号/名称 + 规格 + 客编」；文本四字段严格取行上快照值不回退，缩略图快照图纸挂接优先、无挂接回退物料当前图纸；行有图纸挂接时传 `drawingOwnerType`（如 `sal_order_item`），无挂接的行（库存/报价/制造类）不传。物料选择器/挑选对话框不适用本约定。
- 一切文件上传/下载必须走 `~/lib/files.ts`（REST `/api/v1/files*`），不要在页面自写 fetch/FormData；记录附件 UI 一律用 `SynieAttachmentPanel`（`~/components/synie-attachment-panel/`）挂 SynieRecordDrawer 的 `extraContent`，传 ownerType（资源/宿主类型名）/ownerId；固定单图槽位（证件照等）用同目录 `SynieImageAttachment`，一个 category 一张图。
- 图片全屏预览一律用 `SyniePreview`（`~/components/synie-preview/`）：受控 `isOpen/onOpenChange`，`items` 传 `fileId`（经鉴权懒加载）或 `src`，内建下载/旋转/缩放/循环切换，抽屉/对话框内打开层级自然正确；不要自造 lightbox。缩略图用同目录 `FileThumb`；表格图片列用 DataGrid 列 override `image`（`true`=列值即 file id，或 `{ fileId(row), keepText }`），缩略图点击即全屏预览、同列循环；行记录的图片附件列用 DataGrid `attachmentImages={{ ownerType, category?, label? }}`（虚拟列，点开该行全部图片，与抽屉附件面板同 queryKey 联动刷新）。

## 移动端适配

- 所有页面需考虑移动端适配，桌面/移动断点统一为 `lg`（1024px）。

## HeroUI Pro

项目持有 HeroUI Pro 许可，技术栈为 React 19 + `@heroui/react` v3 + `@heroui-pro/react`（均已安装）。开发 UI 时优先复用组件库，而不是从零搭建。

- 基础组件从 `@heroui/react` 导入，Pro 组件（图表、DataGrid、AppLayout、Sidebar、AI 界面等）从 `@heroui-pro/react` 导入；动手前先查有无现成实现（MCP `heroui-pro` 或 https://heroui.pro/components ）。
- v3 关键约定：子组件用点号（`Card.Header`、`Sheet.Content`）；交互用 `onPress` 不用 `onClick`；无 `HeroUIProvider`；没有 v2 的数字色阶 token（`primary-500` 等），语义色是 `accent`/`success`/`danger`；样式定制用 Tailwind className，不再有 `radius`/`color` 这类 props。
- `NumberField.Group` 的 grid 模板默认按「减 | input | 加」三列排（40px 1fr 40px），不放步进按钮时 input 会被压进 40px 首列；`web/app.css` 已按按钮有无自动收窄列模板兜底，页面直接使用即可，无需再加 `grid-cols-[1fr]`（存量代码里的该 className 属冗余但无害）。
- 品牌色在 `web/app.css` 通过 `--accent` / `--accent-foreground` CSS 变量覆盖。
- AI 辅助开发依赖：`heroui-pro` MCP server 和 `heroui-react-pro` / `heroui-pro-design-taste` 两个 Agent Skills（安装方式见根目录 README「HeroUI Pro」一节）。
- Token 管理：`HEROUI_PERSONAL_TOKEN`（个人，本地 MCP/skills 用）、`HEROUI_AUTH_TOKEN`（团队 CI/CD 用），存放在仓库根目录 `.env`（已 gitignore），不得提交或写进代码。
