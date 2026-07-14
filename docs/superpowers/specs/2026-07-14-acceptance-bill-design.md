# 承兑汇票模块设计(应收承兑)

日期:2026-07-14

## 定位(产品)

- **应收承兑管理**:只管理公司**收到**的承兑汇票(银承/商承/财司承兑),不做应付承兑(自己开出承兑),后者留跟进。
- 承载五类交易:**接收、转让(背书)、兑付(到期托收)、贴现、同公司跨账户调拨**;由已审核交易推导出**当前持有承兑**(段级库存),精确到**公司-银行账户**层级。
- 票据字段参照**中国新一代票据系统**(等分化票据包):子票以**分**为最小单位,交易精确到**子票段** `[子票起, 子票止]`,录入时自动计算减负(`子票止 = 子票起 + 金额×100 − 1`)。
- 交易是 GL 的一个 voucher(与发票、手工凭证地位平等):**审核**时按单据上选定的科目自动生成配平分录并过账(照增值税发票先例);接收/转让带**多态交易对手**(供应商/客户/内部公司),保证应收应付冲抵正确并记录对手。

## 资源结构:三资源 + 三页面

| 资源 | 页面 | 权限前缀 | 说明 |
|---|---|---|---|
| 承兑票据 `acc_bill` | `/finance/bills`(只读台账) | `acc.bill` | 票面档案,一票一条,票号全局唯一;**跨公司共享**(内部公司间转让后仍是同一张票) |
| 承兑交易 `acc_bill_transaction` | `/finance/bill-transactions`(主录入页) | `acc.bill_transaction` | 单表五类型,draft→audited→voided 生命周期,GL voucher |
| 持有承兑 `acc_bill_holding` | `/finance/bill-holdings`(只读) | `acc.bill_holding` | 段级库存,由库存引擎从已审核交易整体重建,无手工 CRUD |

三页面均入财务「资金」菜单组。

## 资源 1:承兑票据 `SynieCore.Acc.Bill`

| 字段 | 说明 |
|---|---|
| `bill_no` | 票据号码(票据包号),string(64),必填,**全局唯一**;不强校验位数(兼容新一代 30 位与存量 ECDS);作 display_field |
| `bill_kind` | 票据种类枚举:`bank_acceptance` 银行承兑汇票 / `commercial_acceptance` 商业承兑汇票 / `finance_company_acceptance` 财务公司承兑汇票,必填 |
| `issue_date` | 出票日期,可空 |
| `due_date` | 票据到期日,**必填**(兑付/贴现日期校验与利息计算依赖) |
| `face_amount` | 票据包金额,decimal,必填,>0;子票总数 = face_amount×100 |
| `drawer_name` / `drawer_account` / `drawer_bank_name` / `drawer_bank_no` | 出票人四件套:全称/账号/开户行名称/开户行行号,文本快照,可空 |
| `payee_name` / `payee_account` / `payee_bank_name` / `payee_bank_no` | 收款人四件套,同上 |
| `acceptor_name` / `acceptor_account` / `acceptor_bank_name` / `acceptor_bank_no` | 承兑人四件套,同上(银承=银行,商承=企业) |
| `transferable` | 能否转让,boolean,默认 true;false(票面「不得转让」)时禁止转让与贴现 |
| `acceptance_date` | 承兑日期,可空 |
| `remarks` | 备注 |

- **建档随接收交易**:无独立新建入口。接收交易 create 时按票号 upsert(见交易资源);台账页仅查看与票面修正。
- **票面修正约束**:`bill_no` 建后不可改;`due_date` / `face_amount` / `transferable` 在该票**存在任何交易(含草稿)后不可改**(库存引擎与日期校验依赖,也保证 holding 冗余的 due_date 不失效);其余票面文本字段随时可改(权限 `acc.bill:update`,审计留痕)。
- **删除**:仅当该票无任何交易(接收草稿删除后遗留的空档案),DB 外键 restrict 兜底。
- **读权限 fail-closed**:super_admin bypass;其他用户过滤「本人可及公司名下有过交易的票据」(exists 关联交易且 company_id 在数据权限内);票据无 company_id,不适用 CompanyScope,需自定义 policy filter。
- permission_actions:`read update delete`(不设 create——建档随接收交易授权,照「纯派生资源不设独立入口」惯例)。
- 附件:挂 SynieAttachmentPanel(票面影像/截图),OwnerRegistry 登记 `acc_bill`。
- 索引:unique `bill_no`;`due_date` 常规索引。

## 资源 2:承兑交易 `SynieCore.Acc.BillTransaction`

| 字段 | 说明 |
|---|---|
| `doc_no` | 单据编号,create 挂 AutoNumber,可空;`(company_id, doc_no)` partial unique |
| `company_id` | → bas_company,必填,建后不可改 |
| `bank_account_id` | → acc_bank_account 本方票据挂靠银行账户,必填;OwnBankAccount 校验同公司,create 时校验启用(照流水先例);调拨时为**转出账户** |
| `transaction_type` | 交易类型枚举:`receive` 接收 / `endorse` 转让 / `settle` 兑付 / `discount` 贴现 / `reallocate` 调拨,必填,**建后不可改**(update 不收;类型错了删草稿重录) |
| `bill_id` | → acc_bill,必填 |
| `occurred_on` | 发生日期,date,必填(交易实际发生日,允许补录历史) |
| `sub_start` / `sub_end` | 子票起/止,bigint,必填;`1 ≤ sub_start ≤ sub_end ≤ face_amount×100` |
| `amount` | 交易金额(段金额),decimal,必填,>0;勾稽 `sub_end − sub_start + 1 = amount×100` |
| `party_type` / `party_id` | 多态交易对手(PartyType:供应商/客户/内部公司 + 裸 uuid,`poly_refs/0` + PartyExists 复用):**receive/endorse 必填**,其余类型必须为空(兑付对手即票面承兑人;贴现对手是金融机构走 discount_org) |
| `discount_org` | 贴现机构,string(64):discount 必填,其余为空;**库存文本**,前端预置常见银行下拉+自由输入 |
| `discount_rate` | 贴现利率(年化 %),decimal:discount 必填,≥0 |
| `interest` | 贴现利息,decimal:discount 必填,≥0;前端自动算可改(以银行实扣为准) |
| `net_amount` | 实收金额,decimal:discount 必填,>0;勾稽 `amount = interest + net_amount` |
| `to_bank_account_id` | → acc_bank_account 调拨**转入账户**:reallocate 必填,同公司、启用、≠ 转出账户;其余为空 |
| `bill_account_id` | 票据科目(应收票据)→ bas_account:除 reallocate 外**审核必填**,草稿可空 |
| `settle_account_id` | 结算科目 → bas_account:除 reallocate 外审核必填;receive=贷方往来(应收账款等),endorse=借方往来(应付账款等),settle/discount=借方银行存款 |
| `interest_account_id` | 利息科目(财务费用)→ bas_account:discount 审核必填 |
| `posting_date` | 过账日期,审核动作参数写入(调拨审核不收、不生凭证) |
| `status` | `draft` 草稿 / `audited` 已审核 / `voided` 已作废,`writable? false`,默认 draft |
| `created_by_id` / `audited_by_id` / `audited_at` | 动作内自动记 actor |
| `remarks` | 备注 |

- **接收建档契约**:receive create 收 `bill_id` **或**票面参数组(票号+票面字段)。前端按票号查档:已存在 → 传 bill_id、票面只读带出;不存在 → 填票面,后端 before_action 按 `bill_no` upsert 建档(内部写入,随交易 create 权限授权;并发撞号时 upsert **挂接不覆盖**——票面以库内先录为准,修正走台账页)。endorse/settle/discount/reallocate 一律传 bill_id(从持有段选出)。
- 科目字段同公司/启用/非汇总由 GL.post! 复检,表单侧 RemoteSelect filter 预筛(照发票先例)。
- update/destroy 仅草稿(audit 之外的写动作一律校验「仅草稿」);接审计 Fragment(update/destroy `require_atomic? false`,destroy `primary? true`)。
- permission_actions:`create read update delete audit void`;`grid_actions/0` 暴露 audit / void(danger)。
- 附件:SynieAttachmentPanel(交易回单/截图),OwnerRegistry 登记 `acc_bill_transaction`。
- CompanyScope fail-closed 读 + HasPermission 全动作 + super_admin bypass;create 挂 CompanyAccessible(照流水/发票样板)。
- 索引:`(company_id, doc_no)` partial unique;`(bill_id, status)`(重放取数);`(company_id, status)`、`(company_id, bank_account_id, occurred_on)` 常规。

## 资源 3:持有承兑 `SynieCore.Acc.BillHolding`

| 字段 | 说明 |
|---|---|
| `company_id` / `bank_account_id` | 持有的公司-账户 |
| `bill_id` | → acc_bill |
| `sub_start` / `sub_end` | 持有段起止,bigint |
| `amount` | 段金额,decimal,冗余落库(=(sub_end−sub_start+1)/100),方便聚合合计 |
| `due_date` | 到期日冗余(排序/筛选用;bill 的 due_date 有交易后锁死,无失效风险) |
| `acquired_on` | 取得日期 = 产生该段的交易发生日期;部分消耗拆出的余段**保留原取得日期** |
| `source_transaction_id` | 取得来源交易 → acc_bill_transaction |
| `label` | 只读 calculation:「票号 段起-段止 金额 到期日」拼串,供 RemoteSelect labelField 选段 |

- **无手工动作**:仅库存引擎内部整删整建,对外只读;permission_actions:`read`;CompanyScope fail-closed。
- **不接审计**(重放整删整建是噪音,交易本身即审计线索)。
- 索引:`(bill_id)`、`(company_id, bank_account_id)`。

## 库存引擎 `SynieCore.Acc.BillLedger`(核心)

持有段以**票据为单位、全链重放**维护,是「顺序承兑库存」的唯一事实来源:

`BillLedger.replay!(bill_id)`,在调用方事务内执行:

1. `FOR UPDATE` 锁 acc_bill 行(该票所有审核/作废串行化,照发票 before_action 锁先例);
2. 取该票**全部 audited 交易**,按 `(occurred_on, audited_at)` 排序,从空态折叠:
   - **receive**:段与当前**全系统**(跨公司跨账户)该票活跃段无重叠(同一子票段现实中只能被一方持有)→ 在 (company, account) 加段,acquired_on = occurred_on,source = 该交易;
   - **endorse / settle / discount**:段 ⊆ 该 (company, account) 当时活跃段(**允许横跨多个相邻持有段**)→ 移除,部分消耗自动拆段,余段保留原 acquired_on/source;
   - **reallocate**:同上从转出账户消耗 + 在转入账户加段(acquired_on = 调拨发生日期,source = 调拨交易);
3. 任一笔不合法即抛错(带单号、冲突段上下文),整个事务回滚;全链合法则**整删整建**该票 holdings。

- **审核** = 置 audited 后 replay!:新交易插入历史链重验,**倒填日期天然被正确校验**(如 7-01 转让 7-10 才接收的段,重放在 7-01 处失败)。同日多笔按 audited_at(录入审核顺序)定序。
- **内部公司间转让**是两笔单据:A 公司录转让(对手=内部公司 B)、B 公司录接收(对手=内部公司 A);同日发生时须**先审转让后审接收**,否则接收因段仍在 A 名下重叠被拒(报错即提示定序)。
- **有条件作废** = 置 voided 后 replay!:移除该笔后链仍合法才允许——「该段被后续交易动过则不可作废」自动成立(报错提示先作废后续交易),无需单独状态机。
- 交易量级:一张票的交易通常数十笔以内,按票重放代价可忽略,正确性易证。

**日期与票面硬校验**(audit 构建期 validate,友好报错):

- 兑付:`occurred_on ≥ due_date`(到期日起才能提示付款);
- 接收/转让/贴现:`occurred_on ≤ due_date`(到期后票据只能托收,不再流转);
- `transferable = false`:**禁止转让与贴现**(兑付/调拨不受限);
- 调拨无日期约束。

## 记账规则(审核自动凭证,照发票先例)

科目在单据上选,借贷方向由交易类型自动决定,用户不指定方向:

| 类型 | 借 | 贷 | 带对手的行 |
|---|---|---|---|
| 接收 receive | 票据科目 amount | 结算科目(应收账款等) amount | 贷方行(party_type/party_id = 交易对手) |
| 转让 endorse | 结算科目(应付账款等) amount | 票据科目 amount | 借方行 |
| 兑付 settle | 结算科目(银行存款) amount | 票据科目 amount | 无 |
| 贴现 discount | 结算科目(银行存款) net_amount;利息科目 interest | 票据科目 amount | 无 |
| 调拨 reallocate | **不生成凭证**(科目不变,仅存放账户变化,只动持有库存) | | |

- 贴现利息为 0(平价贴现)时利息行省略,凭证两行。
- `GL.voucher_resources` 注册 `"acc.bill_transaction" => {BillTransaction, "承兑交易"}`(分录来源单据列回链,AGENTS.md 强制)。
- 全正数分录,不涉 `allow_negative`。

## 生命周期

```
draft ──audit(posting_date, 调拨不收)──▶ audited ──void──▶ voided(终态)
```

- **audit**:齐全性校验(科目齐备、贴现四项勾稽、日期/票面硬校验)→ 三层结构照发票:构建期 validate 友好报错 + before_action `FOR UPDATE` 复检关竞态 + after_action `GL.post!`(调拨跳过)+ `BillLedger.replay!`;记 audited_by/at。
- **void**:仅 audited;`GL.cancel!` 标记原分录 `is_cancelled`(调拨跳过)+ 置 voided + `replay!` 兜底合法性;终态。
- 不做红冲:票据交易纠错场景作废足够(用户裁定);凭证已进已结账期间的场景随「期间关账」跟进项一起考虑。

## 前端

**承兑交易页** `routes/_app/finance/bill-transactions.tsx`(主录入页,照发票页结构):

- DataGrid 列白名单:docNo、companyId、transactionType、billId(fk 链接+速览)、amount、occurredOn、partyId(多态 fk)、discountOrg、status、auditedById;`defaultSort` occurredOn DESC;行动作 audit(弹窗填过账日期,默认发生日期;**调拨审核不弹日期**)、void(danger 确认框)。
- RecordDrawer:transactionType 首字段(createOnly),**字段按类型显隐**;companyId createOnly,effects 清账户/持有段;bankAccountId RemoteSelect 同公司+启用过滤。
  - **接收**:票号自定义 input(`fields.input`,照 journals partyId 先例)——失焦按票号查档,已存在则带出票面只读+挂 bill_id,不存在则展开票面字段组填写;子票起+金额 → effects 自动算子票止(改任二补第三);对手多态照发票先例。
  - **转让/兑付/贴现/调拨**:「持有段」RemoteSelect(数据源 accBillHoldings,filter companyId+bankAccountId,labelField 用 holding `label` calculation)——选段后 effects 带出 billId/subStart/subEnd/amount(默认整段),可改 subStart/amount 做部分交易,subEnd 自动算(合法性后端重放兜底)。
  - **贴现**:discountOrg 预置银行下拉+自由输入;rate/occurredOn(+票据 dueDate)→ effects 自动算 interest(`amount×rate%×天数/360`,四舍五入 2 位)与 netAmount(=amount−interest),均可手改。
  - 科目 RemoteSelect(同公司/启用/非汇总,照发票先例);附件 SynieAttachmentPanel 挂 extraContent。
- **组件扩展(缺口,写计划时核实修订)**:字段条件显隐(`visible` 谓词)与自定义控件(`input`)RecordDrawer **均已具备**,无需扩展;真实缺口两个:① `FieldInputProps` 增 **`patchValues`**(自定义控件回写兄弟字段——选持有段带出票据/段/金额、贴现联动计算依赖);② DataGrid 增 **`pageSummary`** 本页汇总行插槽(持有页金额合计用,全量合计留跟进)。贴现机构用 `fields.input` 挂 HeroUI 允许自由输入的组合框,预置银行清单放前端常量(国有六大行+主要股份行+常见城商行,如工商/农业/中国/建设/交通/邮储/招商/浦发/中信/光大/华夏/民生/广发/兴业/平安/浙商/宁波/北京/上海/江苏/杭州/南京银行等)。

**持有承兑页** `routes/_app/finance/bill-holdings.tsx`(只读,段级明细+汇总):

- DataGrid 列:companyId、bankAccountId、billId(fk 链接)、subStart、subEnd、amount(**聚合合计行**)、dueDate、acquiredOn、sourceTransactionId(fk 链接);`defaultSort` dueDate ASC;按公司/账户/票据筛选即得汇总视角;无新建、无行动作。

**承兑票据台账页** `routes/_app/finance/bills.tsx`(只读+票面修正):

- DataGrid 列:billNo、billKind、faceAmount、issueDate、dueDate、acceptorName、transferable;抽屉 view/edit(票面修正,锁死字段 update 不收);**无新建按钮**(建档随接收);附件面板挂票面影像。

## 系统接入清单(既有规范逐项过)

- `GL.voucher_resources` 注册 `acc.bill_transaction`。
- `synie_core.ex` queries/mutations/resources 三处注册(holdings 只 query 无 mutation);GridMeta `@resources`:accBills / accBillTransactions / accBillHoldings。
- `SynieCore.Files.OwnerRegistry` 登记 `acc_bill`、`acc_bill_transaction`。
- 前端:抽屉 `registry.ts` 三资源;菜单 `menu.ts` 财务「资金」组补 承兑交易/持有承兑/承兑票据;`permission-labels.ts` 补三前缀中文;`logs.tsx` 补表中文标签(holdings 不接审计,无需)。
- 迁移走 `mix ash_postgres.generate_migrations` + `mix ecto.migrate`(`mix ash.migrate` 本机失效)。
- 非 super_admin 需权限矩阵勾选后可见新页面(fail-closed 预期)。

## 测试

- 勾稽:段/金额三者互算与不一致拒绝;段越界(face_amount×100);贴现 `amount = interest + net_amount`;类型-字段矩阵(该空不空/该填未填)。
- 引擎:接收重叠拒(含跨公司);跨相邻段消耗;部分消耗拆段(余段保留原取得日期/来源);倒填日期插链重验(合法通过/非法拒绝);同日多笔按 audited_at 定序;作废后段已被后续消耗拒绝、未消耗成功回滚;调拨转移与转入段取得日期。
- 硬校验:兑付早于到期日拒;到期后接收/转让/贴现拒;不得转让票转让/贴现拒(兑付/调拨放行)。
- 建档:票号不存在建档、已存在挂接、并发 upsert 不撞;有交易后 due_date/face_amount/transferable 锁改;bill_no 建后不可改。
- 记账:五类型分录方向/金额/对手行;贴现三行与利息为 0 两行;调拨零分录;void → GL.cancel!(调拨跳过)。
- 权限:bills exists 过滤 fail-closed;holdings/transactions CompanyScope;票据台账跨公司可见性(内部转让双方均可见)。
- 前端 checks:visibleWhen、combobox;E2E 主流程走查(接收建档→部分转让→贴现→到期兑付→调拨→作废回滚→权限矩阵可见性)。

## 否决的备选

- **交易内嵌票面快照(无票据主档)**:转让/兑付/贴现无法「从持有选票带出」,票面重复录入,与减负目标相悖。
- **四类交易各自资源**:权限/页面粒度细,但字段大量重复、持有引擎要跨四表取数;单表+类型枚举照发票 direction 先例。
- **持有段增量维护(不重放)**:审核只做增量增删,快;但作废/倒填日期需复杂逆操作与时点重叠校验,极易出错;按票全链重放代价可忽略且正确性易证。
- **贴现行入主数据 / PartyType 扩 :bank**:贴现钱当场到账不产生后续应收应付,对手仅存档;用户裁定文本落库+前端预置下拉。
- **红冲机制照发票**:票据交易纠错用有条件作废足够,红冲多一套状态语义;已结账期间场景随期间关账跟进。

## 范围外(跟进项)

- 应付承兑(自己开出承兑汇票)
- 商票拒付(到期提示付款被拒:持有段拒付状态+应收重转 借应收账款/贷应收票据)
- 质押/解质押(持有段冻结,质押期间禁转让/贴现)
- 到期兑付提醒/批量托收
- 贴现计息天数精化(节假日顺延、调整天数,现按 实际天数/360)
- 到期分布透视报表(月度到期金额矩阵)
- 与银行流水关联(贴现/兑付回款对上流水,随流水「凭证关联」跟进项一起)
- 票面 OCR/影像识别预填(结构已备:票面为文本快照,同发票 OCR 预留)
- 背书前后手完整链记录(现记直接对手,完整背书链新一代票据可查,系统不复刻)
- bills 读权限 exists 过滤的性能观察(交易量大时可换物化「可见公司」列)
- 承兑人信用/额度管理、票据池

## 疑问裁定记录(2026-07-14 用户评审)

1. **贴现机构**:库存文本字段,前端预置常见中国银行下拉+自由输入(宁波/工商/农业银行等)——用户拍板。
2. **纠错机制**:有条件作废(回滚持有+GL.cancel!,重放校验兜底"后续动过不可作废")——用户选推荐项。
3. **持有页形态**:段级明细+聚合合计+按公司/账户/票据筛选,到期日排序看临期分布——用户选推荐项。
4. **本轮范围**:额外纳入**同公司跨账户调拨**;商票拒付、质押/解质押放跟进项——用户勾选。
5. **调拨不生成凭证**(仅动持有库存)——方案展示后用户确认「没问题」。
6. **日期/票面硬校验**(兑付≥到期日、接收/转让/贴现≤到期日、不得转让票禁转禁贴)——同上确认。
