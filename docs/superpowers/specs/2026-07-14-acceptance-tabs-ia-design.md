# 承兑汇票单页 Tabs 信息架构

承兑交易、持有承兑、承兑票据三个菜单项合并为一个「承兑汇票」入口,页内以 tabs 承载三个视图。

## 方案对比

- **2 tabs(交易/持有),台账并掉**:台账是唯一能查历史票(已兑付/已转让票不在持有里)、做票面修正、挂票面影像的入口,fk 速览抽屉只读替代不了,否决。
- **3 tabs(选定)**:菜单收敛为单入口,三视图完整保留,tab 即路由。
- **主从式(票据主列表行内展开交易+持有)**:录交易动线变差(先找票才能录),重构量大,否决。

## 约定

- 布局路由 `/finance/acceptance`(`acceptance.tsx`):页标题「承兑汇票」+ HeroUI Tabs + Outlet;tab 由子路由驱动(Tabs.Tab render 包 TanStack Link),URL 可直达可后退。
- 子路由:`transactions`(承兑交易,默认,index 重定向至此)、`holdings`(持有承兑)、`bills`(票据台账);三页面文件独立迁移,不合并;各自保留一句说明文字,去掉自己的 h1。
- 旧路径 `/finance/bill-transactions|bill-holdings|bills` 直接移除,站内无引用。
- 跨 tab 写后显式失效:交易页任何写操作(新增/编辑/审核/作废)统一失效三资源 gridRows;SynieDataGrid 增加 `onMutated` 回调供默认动作(作废)接入。
