# 01 — 占量口径统一与投影列就位（prefactor）

**What to build:** 把后续改动的地基打平——需求单销售占用从「未作废（含草稿）」改为「已确认未作废」（确认时校验占量、作废释放，存量测试口径同步更新）；供应链设置采购 Tab 新增可配的**需求超下单比例**（默认 0、0～100%，百分比录入存小数，同超收比例控件）；需求行冗余 `ordered_qty`/`received_qty` 两列（默认单位口径、默认 0，本票无写入方）与派生「已下单」只读字段（ordered_qty>0 且未完成，不落枚举）。演示：草稿需求单不再占销售条目，确认才占；设置页可配比例。

**Blocked by:** None — can start immediately

**Status:** resolved

**Parent:** [.scratch/demand-purchase-linkage/spec.md](../spec.md)

- [x] 销售占用改确认占量：确认时校验并占量、作废释放；存量含草稿占量的测试口径更新
- [x] 需求超下单比例：存储 + 设置页采购 Tab 读写（同入库超收比例先例）
- [x] 需求行 `ordered_qty`/`received_qty` 列就位（默认 0，无写入方）
- [x] 需求行派生「已下单」只读字段，GraphQL 可读
- [x] 集成测试：草稿不占 / 确认占 / 超占失败 / 作废释放；派生字段口径
