# 07 — 夹具世界批次D：sales + purchase

**What to build:** sales、purchase 两域在权限目录内的全部资源进夹具世界（构造函数 + 应得集声明），从覆盖豁免清单移除，读写矩阵自动覆盖并全绿。销售订单/销售发货是可打印资源，其构造函数是 08（R3 出口场景集）的前置依赖，须能产出可被打印导出引用的完整单据（含明细行）。

**Blocked by:** 02 — 矩阵内核 tracer bullet；03 — 写侧三件套接入矩阵.

**Status:** resolved

- [x] 两域目录资源构造函数齐全，从豁免清单移除
- [x] 销售订单/发货构造函数产出含明细行的完整单据，两司各一张
- [x] 客户物料/通用物料对销侧单据的约束在构造时满足（复用批次C 的物料世界条目）
- [x] 本批全部资源读写矩阵全绿，进 CI

## Comments

落地:sales 6 + purchase 5 = 11 资源进世界,**两张豁免清单彻底清零**,读 54/
写 54/覆盖 3 全绿(累计 206 web 测试)。

- **销售订单/发货完整单据**:两司各一张。订单=已审核样品单 + 一行样品条目
  (样品行免报价链接、qty≤样品上限 100);发货=草稿单 + 一行明细,绑该已审核
  订单条目(DeliveryItem.BindOrderItem 要求源订单已审核)。发货保持草稿——
  审核才动库存/过账,越出全量矩阵射程。复用批次C 的物料/仓库、批次B 的客户。
- **往来角色科目**:发货借方须挂「未开票应收」、收货贷方须挂「未开票应付」,
  对账镜像(销对账贷方=未开票应收、采对账借方=未开票应付)。世界每司加建
  这两个角色科目(MXUR/MXUP),`build_bas_accounts` 认领全部六个科目
  (批次A 的两个普通 + 批次D 的四个角色)。
- **本币单省汇率**:订单/报价 GraphQL 的 currencyId 必填(ID!),写输入传本币
  CNY;币种==本币时汇率被强制为 1,故省略 exchangeRate。
- **空草稿即合法**:报价/对账/收货的世界记录都是空草稿(无明细),正向对照
  的 create→update(remarks)→destroy 全程走通(草稿态可删,无库存/GL 联动)。
- **全局 vs 公司隔离**:sales.customer/purchase.supplier 全局(:global);
  两域其余单据均带 company_id(:company);sales.setting 单行迁移种子认领
  (read_one 出口,whitelist_exempt 保留)。
- **收口就绪**:coverage_exempt 与 batch 常量已删空,工单10 只需复核
  whitelist_exempt 剩余四项(设置类单行,合理保留)与补文档。
