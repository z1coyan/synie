# 12 — 清理 contract 后迁移债并修正基线

**What to build:** 复核 Resource Catalog contract 后仍残留的 basic 表单、命令
fallback、写入 stub 与 drawer 配置，修正会漏算或误报的迁移基线，并以测试固定真实能力
边界。

**Blocked by:** 11 — 收缩并删除旧 Meta 与前端 registries.

Status: resolved

- [x] numbering、storages、print templates、bank import templates、HR 补卡/借款/发放等
  basic 页面统一使用 `useCatalogBasicForm`。
- [x] 全部 17 个 basic 资源都有可枚举的 Catalog Basic Form 消费者。
- [x] 全部 25 个命令资源、53 个声明命令使用显式 CommandAdapter key/target 映射。
- [x] 删除 Proxy/action fallback，并增加全资源 Adapter 覆盖测试。
- [x] ResourceTransport/RecordWriter 省略不支持的写方法；删除 transport、binding 与编号
  计数器写入 stub。
- [x] 销售发货普通 transport 不再暴露 create/update，表单只经 AggregateDraftAdapter。
- [x] FormMeta 强类型化；basic form 重复 required/edit/label 在注册期失败。
- [x] HR 补卡、工资发放、员工借款的可写字段与 Basic Form Meta 对齐。
- [x] settings 与 files 的 presentation 分类纠正为 extension/none。
- [x] drawer registry 只保留实际调用的 21 个 Presentation Extension 配置。
- [x] 基线递归扫描全部资源实现，排除测试文件，并分别报告 basic 消费资源、Proxy/action
  site 与 write stub。
- [x] 删除运行时强制写入的 `catalogSource=typed` 假指标，改报 97 个实际规范化资源。
- [x] shared/server/web 类型检查、测试和生产构建通过。
- [x] ADR、架构说明、前端约定、规格与本工单同步更新。

## Answer

- 基线：97 个服务端资源；17/17 basic 消费覆盖；53/53 命令 Adapter 覆盖；
  `proxyActionHooks=0`、`legacyUsages=0`、`writeStubs=0`。
- 能力 seam：资源解析只经 ResourceBinding；HTTP 层使用 ResourceTransport，普通写、
  聚合草稿和领域命令不再混在同一宽接口。
- 表单 seam：静态字段事实来自服务端 Catalog；页面只叠加运行时上下文、专用输入控件和
  领域 Presentation Extension。
- PE registry：从 84 个历史资源键收缩为 21 个实际调用配置，不再保存 basic/子资源的
  label 占位。
- 本次没有改变领域规则或用户可见业务语义，因此未更新产品说明；没有新增领域术语，
  `CONTEXT.md` 保持不变。

## Comments

- Grok 提出的三项迁移债均确认存在；额外发现 FormMeta 仍为 unknown、基线漏扫、
  basic 消费误报、编号计数器 stub、settings/files 分类错误与已实施架构文档仍标记
  “尚未实施”，以及 `typedResources=97` 并不代表泛型定义覆盖，均在本工单一并修正。
