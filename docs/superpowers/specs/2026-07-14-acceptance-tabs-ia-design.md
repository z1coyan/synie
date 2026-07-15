# 承兑汇票单页 Tabs 信息架构

承兑业务合并为一个「承兑汇票」入口,页内 tabs 承载两个视图:承兑交易、持有承兑。

## 演进

- 第一轮:三菜单项合并为 3 tabs(交易/持有/台账),当时否决 2 tabs 的理由是台账独占历史票查档、票面修正、票面影像三能力。
- 第二轮(现行):台账 tab 撤销,三能力迁移后 2 tabs 无功能损失——
  - 票面档案+影像:accBills 抽屉配置(完整字段布局+附件面板)下沉 `synie-record-drawer/registry.tsx`,任何 billId fk 速览(含已处置票的历史交易行)即完整档案;
  - 票面修正:持有页行操作(需要更正票面的票必然还在持有中,建档随接收完成);
  - 历史票交易:交易页按票据/类型筛选。

## 约定

- 布局路由 `/finance/acceptance`(`acceptance.tsx`):页标题「承兑汇票」+ HeroUI Tabs + Outlet;tab 由子路由驱动(Tabs.Tab render 包 TanStack Link),URL 可直达可后退。
- 子路由:`transactions`(承兑交易,默认,index 重定向至此)、`holdings`(持有承兑)。
- 创建动线定型:接收是唯一凭空创建入口(交易页「新增承兑接收」);转让/兑付/贴现/调拨从持有页票据段行操作发起,持有段整行灌入表单预填,交易类型随入口定死不可改。
- 交易三态抽屉抽为两 tab 共享组件 `acceptance/-transaction-drawer.tsx`(TanStack Router `-` 前缀不当路由)。
- 行操作跨资源写数据时,门控按目标资源 GridMeta 能力反射(发起交易看 accBillTransactions:create,票面修正看 accBills:update),不挂在本表 capability 上。
- 跨 tab 写后显式失效:任何写操作统一失效交易/持有/票据三资源 gridRows;SynieDataGrid `onMutated` 供默认动作(作废/删除)接入,`createLabel` 供定型创建按钮改文案。
