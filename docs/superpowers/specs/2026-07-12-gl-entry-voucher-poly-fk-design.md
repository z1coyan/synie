# 总账分录来源单据多态外键化

## 目标

分录的来源单据(`voucher_type` 字符串判别 + `voucher_id` 裸 uuid)与对手列一样渲染成名称链接,点击开来源单据速览抽屉,并支持列筛选。

## 方案

复用 poly_refs 机制(4069f6d),把 GridMeta"判别值必是枚举"的假设放宽为"枚举或字符串":

- `SynieCore.Acc.GL.voucher_resources/0` 注册 `voucher_type → {资源, 中文标签}`;新单据接 GL 时必须同步注册(AGENTS.md 已立规)。
- `GlEntry.poly_refs/0` 增加 `voucher_id`(判别 `voucher_type`)。
- GridMeta:枚举判别值仍大写 token,字符串判别值原样;variants 映射值支持 `{资源, 标签}` 元组显式中文标签;ref 新增 `discriminator_type`("enum"/"string")。
- 前端 query.ts:polyFk 筛选按 `discriminatorType` 决定判别 eq 字面量是否加引号;行查询自动取回多态列的判别字段(判别列不在可见列也能解析链接)。
- entries 页:`voucherId` 进表格列(链接文本 = 凭证号),删冗余 `voucherNo`/`voucherType` 字符串列;详情抽屉同步。

## 否决的备选

- `voucher_type` 改 Ash 枚举:GraphQL enum token 不允许 `.`,须迁移存储值,成本高。
- 前端 permission-labels 映射变体标签:标签来源分裂,后端 meta 统一供给更一致。

## 取舍

- 顶部快速搜索不再命中凭证号(voucherNo 列移出);来源单据列筛选(远程按凭证号搜)覆盖此场景。
- CSV/打印中多态列仍退截断 id(既有天花板,见批量反查跟进项)。
