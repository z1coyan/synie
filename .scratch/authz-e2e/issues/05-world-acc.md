# 05 — 夹具世界批次B：acc（财务，最大域）

**What to build:** acc 域在权限目录内的全部资源进夹具世界（构造函数 + 应得集声明），从覆盖豁免清单移除，读写矩阵自动覆盖并全绿。本域构造约束最密（借贷平衡的总账分录、编号规则、票据类型、对账关系、发票镜像等），构造函数以"最小合法记录"为目标，不追求业务丰满。

**Blocked by:** 02 — 矩阵内核 tracer bullet；03 — 写侧三件套接入矩阵.

**Status:** resolved

- [x] acc 域目录资源构造函数齐全，从豁免清单移除
- [x] 财务设置类单行表、派生/计算列资源的应得集正确声明
- [x] 本批全部资源读写矩阵全绿，进 CI
- [x] 若单个上下文窗口装不下：按「银行与票据 / 总账与发票」对半拆，后半立新票并在本票注明——不许降覆盖标准换进度（未拆,一票完成）

## Comments

落地:acc 域 10 资源(bank_account/bank_import_template/bank_transaction/bill/
bill_holding/bill_transaction/expense_report/gl_entry/setting/vat_invoice)全部进世界,
豁免清单批次B段清零,读 27/写 27/覆盖矩阵全绿。

- **票据三件套构造**(最深的一条链):票据经内部 `:register` 建档;每司一笔已审核
  收票交易用 `Ash.Seed` 受信种入(绕过审核动作的 GL 联动,保住 acc.gl_entry 的
  独占世界);再跑 `BillLedger.replay!` 让重放引擎推导持仓——BillHolding 的
  `:rebuild` 是其唯一合法写入路径,构造函数按世界票据 id 认领重放产物。
- **第二个 custom 应得集**:acc.bill 全局票据实体「随交易可见」(读策略是
  HasPermission ∧ BillCompanyScope=exists(transactions, company in 授权集))。
  构造函数返回**预载 transactions** 的票据,oracle 消费预载数据不回库;写测试的
  靶记录选取同步泛化为按应得集声明取(甲靶=只授甲应得,乙靶=只授乙应得且甲不应得),
  custom 可见性资源由此吃上跨公司 update/destroy 负向。
- **应得集**:gl_entry/bill_holding/bank_* 等按 :company 默认;bill custom;
  acc.setting 单行迁移种子认领(read_one 出口,与 sys.setting 同款)。
- **最省依赖裁量**:发票取「进项+员工对手」形态(免对账单/客商依赖;employee
  党类型仅 inbound 合法且强制两个对账槽为空);总账分录直建最小合法行
  (资源层无动作校验,单边非零由 DB 约束把关,借贷平衡属 GL.post! 业务校验,
  有各自功能测试);报销/发票的 doc_no 手填免依赖编号规则。
- **跨批次 ctx 预建**:员工(hr,批次C)与客户(sales,批次D)是全局主数据,
  批次B单据引用它们——已在 ctx 预建,**对应批次的构造函数落地时必须认领**
  (moduledoc 有注记,漏认领时该批次独占断言即红)。
- 坑:bill_transaction 挂 AutoNumber(manual_entry)且世界无其编号规则,
  GraphQL 正向 create 必须手填 docNo,否则报「未配置启用的编号规则」。
