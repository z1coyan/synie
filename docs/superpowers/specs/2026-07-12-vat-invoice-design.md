# 增值税发票模块设计

日期:2026-07-12

## 定位(产品)

- 增值税发票台账:登记公司**开出**(销项)与**开入**(进项)的增值税发票。发票是纸面事实的电子档案——双方开票信息、销售清单一律存**文本快照**,不关联物料主数据,不与客户/供应商主数据联动。
- 发票是 GL 的一个 voucher(与手工凭证地位平等):**审核**时按单据上用户选定的三个科目,在同一事务内自动生成配平分录并过账;此后不可修改、不可删除,只能**作废**(实际未开票,原分录打作废标记)或**红冲**(实际已开票,追加红字分录)。
- 对手支持**供应商/客户/内部公司**三类(报销/员工本轮不做)。
- 为未来 OCR 识别预留结构(上传原件 → 解析 → 预填表单),本轮零代码。

## 记账规则(三科目)

发票上选三个科目外键,借贷方向由开入/开出自动决定,用户不指定方向:

| 方向 | 借 | 贷 |
|---|---|---|
| 开出 outbound(销项) | 往来科目(应收) 价税合计 | 价款科目(收入) 未税金额;税额科目(销项税) 税额 |
| 开入 inbound(进项) | 价款科目(费用/成本/资产) 未税金额;税额科目(进项税) 税额 | 往来科目(应付) 价税合计 |

- 税额为 0(免税等):税额科目可空,凭证只两行。
- **仅往来科目行携带对手**(party_type/party_id = 发票对手),与实务的往来挂账一致;价款/税额行不带。
- **红冲开出红冲凭证并把原有凭证置「已红冲」**(用户明确要求):红冲凭证 = 原分录逐条**金额取负**(红字,借贷方向不变)生成的新分录组,行标 `is_reversal`,posting_date 取红冲日期,remarks 冠「红冲」;原分录组同事务内标记 `is_reversed`(已红冲)。同一发票名下两组分录合计归零,发生额正确冲减,凭证视角可分辨原凭证(已红冲)与红冲凭证。

## 数据模型

单表 `acc_vat_invoice`(明细 json 内嵌,无子表),归 `SynieCore.Acc` 域。

| 字段 | 说明 |
|---|---|
| `id` | uuid 主键 |
| `doc_no` | 系统单据编号,create 挂 `AutoNumber`,可空(未配规则则留空);公司内唯一(partial,忽略空值) |
| `company_id` | → bas_company,非空 |
| `direction` | 枚举 `inbound` 开入 / `outbound` 开出,非空 |
| `invoice_date` | 开票日期,草稿可空,审核必填 |
| `posting_date` | 过账日期,审核动作参数写入 |
| `party_type` / `party_id` | 对手(对方类型/对手ID),沿用分录与凭证行的对手命名;PartyType 枚举(supplier/customer/**company 新增**)+ 裸 uuid,非空;`poly_refs/0` 声明多态 fk;存在性校验复用 PartyExists(从凭证行提升为 `SynieCore.Acc.PartyExists` 共享模块) |
| `invoice_kind` | 发票类型枚举:`special` 专用发票 / `normal` 普通发票 / `electronic_special` 电子专票 / `electronic_normal` 电子普票 / `digital_special` 数电专票 / `digital_normal` 数电普票,非空 |
| `invoice_code` | 发票代码,非空**默认空串**(数电票无代码存空串,规避可空列参与唯一索引的 NULL 语义) |
| `invoice_no` | 发票号码,草稿可空,审核必填;防重录唯一索引见下 |
| `seller_name` / `seller_tax_no` / `seller_address_phone` / `seller_bank_account` | 销售方名称/税号/地址电话/开户行及账号,文本快照,可空 |
| `buyer_name` / `buyer_tax_no` / `buyer_address_phone` / `buyer_bank_account` | 采购方同上四项 |
| `items` | 销售清单,`{:array, :map}` jsonb,默认 `[]`;行 schema:`name` 物料名称 / `model` 规格型号 / `unit` 单位 / `quantity` 数量 / `price` 单价 / `net_amount` 金额 / `tax_rate` 税率 / `tax_amount` 税额——纯文本记录,**不强校验行合计=头金额**(容尾差);GraphQL 走 `json_string`(照 Numbering.Rule.segments 先例) |
| `net_total` / `tax_total` / `gross_total` | 未税总金额/总税额/价税合计,decimal,草稿可空,审核必填且 `net+tax=gross`、`gross>0`、`tax≥0` |
| `issuer` / `reviewer` / `payee` | 发票纸面栏位:开票人/复核人/收款人,文本可空(注意与系统审核人区分) |
| `remarks` | 备注 |
| `party_account_id` / `amount_account_id` / `tax_account_id` | → bas_account 三科目:往来/价款/税额;审核必填(税额科目仅 `tax_total>0` 时必填);同公司/启用/非汇总由 GL.post! 复检,表单侧 RemoteSelect filter 预筛 |
| `red_invoice_no` | 红字发票号码,红冲动作可选参数,存档用 |
| `mirror_invoice_id` | → acc_vat_invoice 自引用,可空;内部公司**对向发票**互链(DB 外键 on_delete nilify,镜像草稿被删则链接自动置空) |
| `status` | 枚举 `draft` 草稿 / `audited` 已审核 / `voided` 已作废 / `reversed` 已红冲,`writable? false`,默认 draft |
| `created_by_id` / `audited_by_id` / `audited_at` | 创建人/审核人/审核时间,动作内自动记 actor |
| 时间戳 | inserted_at / updated_at |

索引与唯一性:

- 防重录:custom unique index `(company_id, invoice_code, invoice_no)` **WHERE invoice_no IS NOT NULL**(草稿无号不占坑)。不用纯「公司+号码」:老式票 8 位号码仅在发票代码批次内唯一,跨代码撞号会误伤合法录入;invoice_code 以空串代 NULL 后,数电票场景判重与「公司+号码」等价,且无需 PG15 的 NULLS NOT DISTINCT。
- `(company_id, doc_no)` partial unique(doc_no 非空时)。
- `(company_id, status)`、`(company_id, invoice_date)` 常规查询索引。

大写金额**不落库**:前端由 `gross_total` 派生显示(新建人民币大写工具),避免与金额不一致。

## 生命周期

```
draft ──audit(posting_date)──▶ audited ──void──▶ voided(终态,实际未开票)
                                   └──reverse(posting_date, red_invoice_no?)──▶ reversed(终态,实际已开票)
```

- **draft**:头(含 items json)可改,可删;audit 之外的一切写动作校验「仅草稿」。
- **audit**(草稿→已审核):校验齐全性(发票号码、开票日期、对手、三金额勾稽、科目齐备)后照 GlJournal 三层结构——构建期 validate 友好报错 + before_action `FOR UPDATE` 复检关竞态 + after_action `GL.post!` 生成分录;记 audited_by/at。
- **void**(已审核→已作废):调 `GL.cancel!` 标记原分录 `is_cancelled`;终态。
- **reverse**(已审核→已红冲):after_action 调 `GL.reverse!` ——开出红冲凭证(红字分录组)并把原有凭证(原分录组)标记「已红冲」;终态。红冲后不可再作废。
- audited/voided/reversed:update/destroy 一律挡死;附件不受限(sys_attachment 独立于发票写权限)。

权限码 `acc.vat_invoice`,permission_actions:`create read update delete audit void reverse`(审核/作废/红冲是用户视角独立能力);`grid_actions/0` 暴露 audit/void/reverse 行级动作(void/reverse 标 danger)。接审计 Fragment(update/destroy `require_atomic? false`,destroy `primary? true`)。

## GL 层扩展:红字分录(本设计唯一的核心层改动)

现状 GL 只有「作废标记」,无红冲能力;DB CHECK 与 `validate_entries` 均强制借贷「恰一边>0」,负数进不去。扩展(红冲做成 GL 通用能力,所有 voucher 共用):

- DB CHECK `single_sided_amount` 放宽为「恰一边 ≠ 0」(`(debit = 0) <> (credit = 0)`,允许负值);migration 改约束。
- `GL.post!(voucher, entries, opts \\ [])` 增加 `opts[:allow_negative]`(默认 false):false 时校验「恰一边>0」——**既有单据行为不变**;true 时校验「恰一边≠0」,仅红冲路径使用。
- `GlEntry` 新增两个 boolean 标记(默认 false)+ 内部 `mark_reversed` 动作:`is_reversed`(该行已被红冲,原凭证状态)与 `is_reversal`(该行是红字冲销行);与 `is_cancelled` 同为消费侧显式过滤的标记,不删数。
- **新增 `GL.reverse!(voucher_type, voucher_id, posting_date)`**:事务内读取该单据全部有效分录(未作废、未红冲),逐条金额取负生成红字分录组(`is_reversal: true`,remarks 冠「红冲」,voucher 三元组沿用原单据),原分录标记 `is_reversed`。红冲凭证由此开出,原有凭证状态即「已红冲」。
- 借贷配平(∑debit=∑credit)、科目/对手校验不变,天然兼容负数;报表 SUM 语义正确(红字冲减发生额)。
- 手工凭证 GlJournal 自身的「恰一边>0」校验保持不动;GlJournal 接入 reverse(红冲手工凭证)留跟进项——能力已通用,随时可挂。
- 跟进项「GL.post! 防重复过账守卫」落地时,需给红冲追加场景留口子(同 voucher 允许追加红字组)。

## PartyType 扩展:内部公司

- `SynieCore.Acc.PartyType` 增加 `:company`(内部公司),`party_resources/0` 加 `company: Base.Company`。
- 分录/凭证行/发票的多态对手列自动多出「内部公司」变体(GridMeta 反射,按 Company read 权限 fail-closed);凭证行 PartyExists 按 map 分发自动覆盖。凭证行能选内部公司属合理外溢(内部往来)。

## 前端

页面 `routes/_app/finance/invoices.tsx`,照凭证页(`journals.tsx`)结构:

- **DataGrid** 列白名单:doc_no、company、direction、counterparty_id(多态 fk 链接)、invoice_kind、invoice_no、invoice_date、gross_total、status、audited_by;行动作 audit(actionHandlers 接管,照凭证审核弹窗填过账日期,默认取开票日期)、void(danger 确认框)、reverse(自建弹窗:红冲过账日期 + 红字发票号可选)。
- **RecordDrawer** fields:多态对手用 `fields.input` 自定义(照 journals partyId 先例),`party_type`/`direction` 变更 effects 清空对手并按方向自动带出本方名称(开出:销售方=公司名、采购方=对手名;开入反之;主数据现仅有名称,税号等手填);三科目 RemoteSelect(filter 同公司/启用/非汇总,照 journals 先例);金额三字段默认手填(票面为准),明细区提供「从明细汇总带出」按钮;价税合计大写在 extraContent 派生显示;items 用 SynieEditableTable 挂 extraContent(items 状态页面自持,照 journals lines 先例);附件用 SynieAttachmentPanel 挂 extraContent(create 态提示保存后上传)。
- **组件扩展(缺口)**:①SynieEditableTable / SynieRecordDrawer 增加「本地 meta」模式——新增可选 `meta` prop(显式传入 `GridColumnMeta[]` 列/字段定义),提供时跳过 GridMeta 查询,以支撑内嵌 json 明细(行 id 沿用 `local:` 前缀,提交时剥离);②RecordDrawer `extraContent` 增加第四参 `patchValues`(向表单草稿写回补丁,view 态无效)——支撑「从明细汇总带出」,也是未来 OCR 解析预填的通道。
- **新工具** `app/lib/amount.ts`:金额千分位两位小数格式化 + 人民币中文大写;发票页金额列经 `overrides.render` 挂入(DataGrid decimal 列全局格式化留跟进)。
- 抽屉注册 `registry.ts`、菜单 `menu.ts` 财务组、权限中文标签 `permission-labels.ts` + `logs.tsx` 同步补。
- 总账分录页(`entries.tsx`)补 `is_reversed`/`is_reversal` 两布尔列(与 `is_cancelled` 同型),红冲状态在凭证视角可见。

## 系统接入清单(既有规范逐项过)

- `GL.voucher_resources/0` 注册 `"acc.vat_invoice" => {VatInvoice, "增值税发票"}`(分录来源单据列渲染链接,AGENTS.md 强制)。
- `synie_core.ex` queries/mutations/resources 三处注册;GridMeta `@resources` 白名单登记。
- `SynieCore.Files.OwnerRegistry` 登记附件宿主 owner_type(新规,漏了附件下载 fail-closed)。
- 迁移走 `mix ash_postgres.generate_migrations` + `mix ecto.migrate`(勿手写迁移;`mix ash.migrate` 本机失效)。

## 内部公司对向发票(2026-07-12 用户新增需求)

对手为内部公司时,同一张纸面发票在两家公司各有一条台账(A 开出 ↔ B 开入)。为省二次录入:

- **触发**:新建保存成功且 `party_type = company` 时,弹确认框「是否为对手公司创建对向发票草稿?」;仅 create 后提醒,编辑/审核不再提醒(防重复);与「顺手审核」弹窗撞车时镜像框优先,关闭后再按 posting_date 判断弹审核框。
- **镜像规则**:company ↔ party 互换(新票 company = 原票对手公司,party 反指原票公司);direction 取反(开出↔开入);票面字段原样复制(开票日期/种类/代码/号码/双方八字段/明细/金额/开票人三栏/备注)——同一张纸面发票;**不复制**:doc_no(对方公司自行编号)、三科目(对方公司科目体系不同,留空待补)、posting_date、附件;状态 = 草稿。
- **互链**:`mirror_invoice_id` 自引用外键,镜像创建成功后两票互写(原票此刻仍是草稿,可 update 回写);前端 fk 列/字段自动渲染成可点链接。
- **权限**:走正常 create 权限与公司数据权限(fail-closed)——当前用户对对手公司无权限则创建失败,提示到对方公司手工登记;不开 `authorize?: false` 后门。
- **实现放前端**(确认框后二次 `createAccVatInvoice`):交互本质是「询问用户」,非原子性需求;镜像草稿由对方公司经办人补科目后自行审核。
- 唯一索引不冲突:镜像票与原票同代码同号码但不同公司。

## OCR 预留(零代码)

- 接入路径:上传原件(附件面板)→ 未来后端 action `ocr_parse(file_id)` 返回与表单同构的字段 JSON(含 items 数组)→ 前端 create 抽屉整体预填。
- 本设计的结构性预留:双方信息为文本快照、清单为 json 数组,即 OCR 的自然输出形态;无需为 OCR 预埋任何字段或端点。

## 否决的备选

- **明细独立子表**(照 GlJournalLine + EditableTable 现成路径):行级校验/未来关联物料更顺,但发票清单是纯文本档案,无行级外键与校验需求,子表徒增迁移、行 diff 持久化与公司冗余同步成本;json + 组件本地 meta 模式更轻,且组件扩展对未来其他 json 明细场景可复用。**若未来要关联物料,再迁子表**。
- **红冲用借贷对调正数反向凭证**:不动 GL 约束,但科目发生额虚增,不符合红字冲销实务,弃。
- **红冲生成独立红字发票记录**(负数发票单据):引入负数发票语义与镜像管理,本轮以原单状态 + red_invoice_no 存档代替。
- **大写金额落库**:与 gross_total 有不一致风险,派生显示即可。

## 本轮范围

后端:PartyType 扩展、GL 红字扩展、`acc_vat_invoice` 资源(动作/权限/审计/编号/校验/镜像互链字段)+ 迁移 + 测试;前端:组件本地 meta 扩展、金额/大写工具、发票页(表格+抽屉+三动作弹窗+对向发票确认框)+ 标签菜单注册。

## 范围外(跟进项)

- 客户/供应商/公司主数据补开票信息字段(税号/地址电话/开户行),表单自动带出升级(现仅带名称)
- 报销发票(员工对手,PartyType 扩 :user)
- 对向发票增强:审核联动提醒、附件跨票引用、按对方公司常用科目预填
- 部分红冲(按金额部分冲销)
- 红字发票作为独立发票记录
- 进项税抵扣认证状态管理
- 手工凭证 GlJournal 接入红冲(`GL.reverse!` 已通用,挂 reverse 动作+状态枚举加 reversed 即可)
- 期间关账(锁 posting_date,GL 层既有跟进项)
- GL.post! 防重复过账守卫(落地时放行红冲追加)
- 分录 read 默认过滤含红冲对(是否默认隐藏 is_reversed/is_reversal 成对行,随既有 include_cancelled 跟进项一起定)
- DataGrid decimal 列全局金额格式化选项
- OCR 实际接入(解析服务选型、ocr_parse action、预填交互)

## 疑问裁定记录(2026-07-12 用户回复「其他应该问题不大」)

1. **红冲=红字负数分录,放宽 GL 核心 CHECK** —— 已确认。
2. **明细用 json 存 + 组件本地 meta 扩展** —— 已确认。
3. **发票类型枚举六值**(卷票等归入 normal) —— 已确认。
4. **「审核人」=系统审核人**,纸面开票人/复核人/收款人为文本字段 —— 已确认。
5. **发票唯一性**:用户提议「公司+发票号码」;裁定保留发票代码参与判重(老式票号码仅在代码批次内唯一,纯号码判重会误伤),invoice_code 改非空默认空串——数电票场景与「公司+号码」等价,且不再依赖 PG15。
6. **内部公司对向发票**为用户新增需求,已纳入本轮范围(见专节)。
