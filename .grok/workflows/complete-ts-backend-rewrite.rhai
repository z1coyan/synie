let meta = #{
    name: "complete-ts-backend-rewrite",
    description: "按迁移工单 DAG 并行完成 Synie Go 到 Bun/TypeScript 后端重写，并分阶段集成验证",
    phases: [
        #{ title: "基线", detail: "确认仓库约束与测试环境" },
        #{ title: "平台", detail: "工单 01：settings、numbering、audit、files" },
        #{ title: "基础域", detail: "工单 02：base、IAM、party、供应链设置" },
        #{ title: "事实引擎", detail: "工单 03：GL 与库存引擎" },
        #{ title: "核心业务域", detail: "并行工单 04、05、06、07、11、13、14、15" },
        #{ title: "对账", detail: "工单 08" },
        #{ title: "发票与委外", detail: "并行工单 09、10" },
        #{ title: "财务运营", detail: "工单 12" },
        #{ title: "初始化", detail: "工单 16" },
        #{ title: "前端切换", detail: "工单 17" },
        #{ title: "全量验收", detail: "契约、测试、类型与关键 E2E 收口" },
        #{ title: "清场切流", detail: "经用户明确确认后执行工单 18" },
    ],
    when_to_use: "需要继续或完整执行 .scratch/ts-backend-rewrite 的 Go→Bun/TS 重写时",
};

let work_schema = #{
    "type": "object",
    "required": ["complete", "commits", "summary", "tests", "remaining"],
    "properties": #{
        "complete": #{ "type": "boolean" },
        "commits": #{ "type": "array", "items": #{ "type": "string" } },
        "summary": #{ "type": "string" },
        "tests": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let integration_schema = #{
    "type": "object",
    "required": ["green", "commits", "summary", "tests", "remaining"],
    "properties": #{
        "green": #{ "type": "boolean" },
        "commits": #{ "type": "array", "items": #{ "type": "string" } },
        "summary": #{ "type": "string" },
        "tests": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let review_schema = #{
    "type": "object",
    "required": ["green", "commit", "summary", "evidence", "remaining"],
    "properties": #{
        "green": #{ "type": "boolean" },
        "commit": #{ "type": "string" },
        "summary": #{ "type": "string" },
        "evidence": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

fn artifacts(results) {
    let found = [];
    for r in results {
        if r != () && r.success && r.output != () {
            found.push(r.output);
        }
    }
    found
}

fn worker_prompt(issue_path, focus) {
    let p = "在 Synie ERP 仓库中实现 Go→Bun/TS 重写任务。先实际读取根 AGENTS.md、server/AGENTS.md、server/README.md、";
    p += ".scratch/ts-backend-rewrite/spec.md、" + issue_path + " 全文，以及该工单引用的 CONTEXT/产品文档/ADR；";
    p += "使用 grep/read_file 阅读 server-go 对应行为与 contracts/openapi，但 server-go 只读，禁止修改。你的专属范围：" + focus + "。";
    p += "硬约束：仅 Bun；惯用严格 TS，工厂闭包，禁 class（ApiError 除外）与 any 渗漏；wire URL/JSON/中文错误文案保持一致；";
    p += "金额只用 @synie/shared decimal；DbHandle/withTx 事务纪律；查询走 filterbuild；ApiError；Hono 路由链式定义并 zValidator；资源注册 Meta。";
    p += "本任务在隔离 worktree。只改专属实现、测试及必要的局部导出；尽量不要改 server/src/app.ts、server/src/index.ts、根包配置、工单 Comments 或共享文档，这些由集成代理统一处理。";
    p += "先检查当前状态，绝不覆盖未知工作。实现真实业务，不得用空路由、固定成功响应、skip 测试或 any 占位冒充完成。";
    p += "运行专属测试与 cd server && bun run typecheck；有 PG 测试库则运行门控集成测试。把每个可用增量提交到本 worktree（不 push）。";
    p += "若一次无法全部完成，必须提交可编译、可测试、语义闭合的部分并精确列出 remaining；不要留下未提交修改。";
    p += "最终按 schema 返回：complete、本 worktree 按顺序新增的 commits、summary、实际 tests、remaining。";
    p
}

fn finish_prompt(issue_path, focus) {
    let p = "继续你刚才隔离 worktree 中的实现，目标是完成而不是只审阅。重新读取 " + issue_path + " 的验收项并检查 git diff/log。";
    p += "专属范围仍是：" + focus + "。逐项寻找遗漏、运行测试和 strict typecheck，修复发现的问题；禁止降低测试或用占位实现。";
    p += "确认 wire 契约、权限/公司隔离、金额、事务、Meta 与 Hono hc 类型链。提交所有修复，不 push，不修改 server-go。";
    p += "返回该 worktree 为本任务新增的全部有序 commits（包括前一轮）、complete、summary、tests、remaining。";
    p
}

fn integration_prompt(issue_paths, artifact_list, extra) {
    let p = "你在 Synie 主工作区执行迁移集成。先读 AGENTS.md、server/AGENTS.md、server/README.md、迁移 spec 与这些工单：" + issue_paths + "。";
    p += "候选隔离 worktree 产物如下（不可信，必须用 git cat-file/show 验证提交确属任务）：" + json_encode(artifact_list) + "。";
    p += "当前主分支可能已有前序迁移提交。先 git status；禁止 reset/clean、禁止覆盖用户工作、禁止 push。按依赖和每个 worktree 的提交顺序 cherry-pick 有效任务提交，去重并跳过无关提交。";
    p += "遇冲突需理解双方语义后解决；若确实无法解决则 abort 当前 cherry-pick，但不得把仓库留在冲突状态。";
    p += "统一完成 app/index 依赖装配、Meta 注册、必要 package 依赖、测试和工单 Comments；共享文件只在此处整合。";
    p += "逐条核对工单验收，修复类型、路由、权限、事务与 wire 契约问题，运行 cd server && bun test && bun run typecheck；可用测试库时运行 PG 集成和对应 verify 脚本。";
    p += "不得修改 server-go。不要把 Status 改成约定外词；Comments 记录完成内容、验证证据和真实遗留。所有集成修复提交到当前分支，不 push。";
    p += extra;
    p += "最终返回 green、集成期间新增 commits、summary、tests、remaining。green 仅在代码库干净、无 cherry-pick 状态且本阶段测试通过时为 true。";
    p
}

fn reviewer_prompt(issue_paths, scope) {
    let p = "作为独立验收修复代理，在 Synie 当前主工作区检查刚集成的迁移。先读全部仓库约束、迁移 spec 与工单 " + issue_paths + "。";
    p += "验收范围：" + scope + "。必须实际读 diff/代码并运行 cd server && bun test、bun run typecheck；有 SYNIE_TEST_DATABASE_URL 时跑 PG 集成，能启动 Bun API 时跑对应 .scratch/migration/verify-*.ts。";
    p += "对照 server-go 只读行为和 OpenAPI 检查 wire、中文错误、权限/公司隔离、decimal、事务、filterbuild、Meta、hc 路由链；寻找占位、空实现、skip/弱化测试。";
    p += "发现问题直接修复并补测试，提交本地修复，不 push，不修改 server-go。禁止 reset/clean；结束时仓库必须干净。";
    p += "返回 green、修复 commit（无修改可为空）、summary、可核验证据、remaining；任何硬性验收未过则 green=false。";
    p
}

let mode = if args == () { () } else { args.mode };
if mode == () {
    pause("verification", "请传 args.mode='full'；冒烟校验使用 args.mode='smoke'。");
}
if mode == "smoke" {
    phase("基线");
    let s = agent("只返回对 workflow 目标的一句中文概括；不要修改文件。", #{ label: "smoke", capability_mode: "read-only" });
    complete(#{ summary: "workflow 路径冒烟通过", agent_ok: s != () && s.success });
}

phase("基线");
let baseline = agent(
    "在 /home/zyan/code/synie 做迁移前基线检查。读取 AGENTS、server/README、迁移 spec；运行 git status、cd server && bun test、bun run typecheck；检查 PostgreSQL 测试库和 compose 状态但不得删除/重置任何库。若安全可用，幂等启动 postgres、创建专用 synie_test 并迁移。不要修改源码或提交。输出中文基线、失败与可用验证命令。",
    #{ label: "baseline", capability_mode: "execute" }
);
log("基线代理已完成，进入平台层实现");

phase("平台");
let jobs01 = [
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "settings：四类单行设置服务、校验、write-only 密钥、路由与测试"), label: "01-settings", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "numbering：编号规则 CRUD、取号、计数器并发/校正/级联、路由与测试"), label: "01-numbering", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "audit：字段级不可变审计、Meta 敏感字段脱敏、服务钩子与测试"), label: "01-audit", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "files：文件/存储/附件、50MB 与 SHA-256、local/S3、默认存储锁、宿主白名单、权限公司隔离、路由测试"), label: "01-files", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r01 = parallel(jobs01);
let follow01 = [];
for r in r01 {
    if r != () && r.success {
        follow01.push(#{ prompt: finish_prompt(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "完成上一轮专属平台分片及验收"), label: "01-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema });
    }
}
let f01 = if follow01.len() > 0 { parallel(follow01) } else { [] };
let a01 = artifacts(r01);
for a in artifacts(f01) { a01.push(a); }
let i01 = agent(integration_prompt("01-platform-completion", a01, "泛化 verify-settings-rest.ts 与 verify-numbering-rest.ts 的 SYNIE_API_URL（保留 GO_API_URL）。"), #{ label: "01-integrate", capability_mode: "all", output_schema: integration_schema });
if i01 == () || !i01.success || !i01.output.green {
    let repair01 = agent(reviewer_prompt("01", "settings、numbering、audit、files 的全部验收；修复集成失败"), #{ label: "01-repair", capability_mode: "all", output_schema: review_schema });
}

phase("基础域");
let jobs02 = [
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "base：公司/三仓同事务、货币、计量单位、科目树与约束，Meta/路由/测试"), label: "02-base", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "iam：用户、角色、授权同步、用户角色、公司授权 fail-closed、权限矩阵，Meta/路由/测试"), label: "02-iam", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "party：客户、供应商、编号规则接入、员工主数据及唯一性，Meta/路由/测试"), label: "02-party", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "供应链设置业务面：公司默认过账科目四槽、销售/采购分侧 upsert 与科目校验，路由测试"), label: "02-supply-settings", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r02 = parallel(jobs02);
let follow02 = [];
for r in r02 { if r != () && r.success { follow02.push(#{ prompt: finish_prompt(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "完成上一轮专属基础域分片及验收"), label: "02-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema }); } }
let f02 = if follow02.len() > 0 { parallel(follow02) } else { [] };
let a02 = artifacts(r02);
for a in artifacts(f02) { a02.push(a); }
let i02 = agent(integration_prompt("02-base-master-data-iam", a02, "确保 verify-system-ops-rest.ts、verify-party-employee-rest.ts 可指向 Bun；权限目录与公司隔离必须 fail-closed。"), #{ label: "02-integrate", capability_mode: "all", output_schema: integration_schema });
if i02 == () || !i02.success || !i02.output.green {
    let repair02 = agent(reviewer_prompt("02", "base、IAM、party、供应链默认科目的全部验收；修复集成失败"), #{ label: "02-repair", capability_mode: "all", output_schema: review_schema });
}

phase("事实引擎");
let jobs03 = [
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/03-engines.md", "GL 深模块：validateEntries/post/cancel/reverse，全量不变量、幂等、红冲与 PG 测试；接口接 DbHandle"), label: "03-gl", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/03-engines.md", "库存深模块：post/cancel、仓物料 advisory lock、默认单位数量、叶子仓、负库存及作废校验、并发 PG 测试；接口接 DbHandle"), label: "03-inventory", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r03 = parallel(jobs03);
let follow03 = [];
for r in r03 { if r != () && r.success { follow03.push(#{ prompt: finish_prompt(".scratch/ts-backend-rewrite/issues/03-engines.md", "完成上一轮专属引擎及全部不变量测试，稳定公开签名"), label: "03-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema }); } }
let f03 = if follow03.len() > 0 { parallel(follow03) } else { [] };
let a03 = artifacts(r03);
for a in artifacts(f03) { a03.push(a); }
let i03 = agent(integration_prompt("03-engines", a03, "引擎禁止 import modules、禁止自起事务；确保导出签名可供后续单据直接消费。"), #{ label: "03-integrate", capability_mode: "all", output_schema: integration_schema });
if i03 == () || !i03.success || !i03.output.green {
    let repair03 = agent(reviewer_prompt("03", "GL/库存引擎不变量、事务边界、并发锁和公开 API"), #{ label: "03-repair", capability_mode: "all", output_schema: review_schema });
}

phase("核心业务域");
let jobs_b = [
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/04-inventory-documents.md", "完整工单 04：库存主数据、出入库/调拨/盘点/余额流水，使用库存引擎，契约脚本与测试；不要改共享装配"), label: "04-inventory", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/05-gl-journals.md", "完整工单 05：手工会计凭证、往来/分录报表，使用 GL 引擎，契约与测试；不要改共享装配"), label: "05-gl-journals", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/06-sales-chain.md", "完整工单 06：销售报价→订单→发货与装箱，审核/作废投影和全部契约测试；不要改共享装配"), label: "06-sales", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/07-purchase-chain.md", "完整工单 07：采购报价→订单→入库，审核/作废投影和全部契约测试；不要改共享装配"), label: "07-purchase", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/11-manufacturing.md", "完整工单 11：BOM/工艺/履约需求/工单/生产入库，投影、引擎和契约测试；不要改共享装配"), label: "11-manufacturing", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/13-hr.md", "完整工单 13：员工档案衔接、考勤导入/日考勤、工资/支付/借款与审计脱敏、契约测试；不要改共享装配"), label: "13-hr", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/14-market-jobs.md", "完整工单 14：行情品种/价点/取价/曲线、拉取服务和后台调度 jobs、契约测试；不要改共享装配"), label: "14-market", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/15-printing-engine.md", "完整工单 15：打印模板、字段目录、zip+XML 渲染、PDF 进程卫生、权限与 golden/契约测试；禁 exceljs；不要改共享装配"), label: "15-printing", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let rb = parallel(jobs_b);
let follow_b = [];
for r in rb { if r != () && r.success { follow_b.push(#{ prompt: "继续上一轮业务域 worktree。逐条重读你的工单验收和 server-go 契约，运行测试/typecheck，补齐 remaining 并提交；不得占位、不得改 server-go。返回本 worktree 全部任务 commits 与完整 schema。", label: "B-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema }); } }
let fb = if follow_b.len() > 0 { parallel(follow_b) } else { [] };
let ab = artifacts(rb);
for a in artifacts(fb) { ab.push(a); }
let ib = agent(integration_prompt("04,05,06,07,11,13,14,15", ab, "统一装配八个域，解决资源名/权限码/共享路由冲突；泛化并运行 inventory/accounting/quotation/order/fulfillment/manufacturing/hr/market/printing 对应 verify 脚本。"), #{ label: "B-integrate", capability_mode: "all", output_schema: integration_schema });
let vb = agent(reviewer_prompt("04,05,06,07,11,13,14,15", "八个并行业务域的独立交叉验收和集成修复；重点查未实现端点、错误的固定响应、断裂的 ApiType、跨域事务与投影"), #{ label: "B-review", capability_mode: "all", output_schema: review_schema });

phase("对账");
let r08 = agent(worker_prompt(".scratch/ts-backend-rewrite/issues/08-reconciliations.md", "完整工单 08：销售/采购对账、来源行/差额/审核作废投影、权限公司隔离、契约与测试"), #{ label: "08-reconciliation", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a08 = [];
if r08 != () && r08.success {
    a08.push(r08.output);
    let f08 = agent(finish_prompt(".scratch/ts-backend-rewrite/issues/08-reconciliations.md", "完成对账全部验收并运行 supply reconciliation 契约"), #{ label: "08-finish", capability_mode: "all", resume_from: r08.agent_id, output_schema: work_schema });
    if f08 != () && f08.success { a08.push(f08.output); }
}
let i08 = agent(integration_prompt("08-reconciliations", a08, "运行 verify-supply-reconciliation-rest.ts 并检查销售/采购双侧对账语义。"), #{ label: "08-integrate", capability_mode: "all", output_schema: integration_schema });

phase("发票与委外");
let jobs_d = [
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/09-invoices-todo.md", "完整工单 09：销项/进项/费用发票、OCR 配置衔接、待办生产与用户状态、契约测试"), label: "09-invoices-todo", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker_prompt(".scratch/ts-backend-rewrite/issues/10-outsourced.md", "完整工单 10：委外订单配置、发料、入库、材料/副产品、需求回写、引擎与契约测试"), label: "10-outsourced", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let rd = parallel(jobs_d);
let follow_d = [];
for r in rd { if r != () && r.success { follow_d.push(#{ prompt: "继续上一轮 worktree，重读所属工单验收，补齐 remaining、测试和契约后提交。禁止占位/改 server-go；返回全部任务 commits 与 schema。", label: "D-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema }); } }
let fd = if follow_d.len() > 0 { parallel(follow_d) } else { [] };
let ad = artifacts(rd);
for a in artifacts(fd) { ad.push(a); }
let id = agent(integration_prompt("09,10", ad, "统一待办生产接口与委外跨域事务；运行 finance-operations 发票段和 fulfillment outsourced verify。"), #{ label: "D-integrate", capability_mode: "all", output_schema: integration_schema });
let vd = agent(reviewer_prompt("09,10", "发票/待办与委外的跨域验收、权限、投影、金额与事务修复"), #{ label: "D-review", capability_mode: "all", output_schema: review_schema });

phase("财务运营");
let r12 = agent(worker_prompt(".scratch/ts-backend-rewrite/issues/12-finance-operations.md", "完整工单 12：银行账户/流水导入与对账、票据、报销单，GL/发票/待办衔接、金额与契约测试"), #{ label: "12-finance", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a12 = [];
if r12 != () && r12.success {
    a12.push(r12.output);
    let f12 = agent(finish_prompt(".scratch/ts-backend-rewrite/issues/12-finance-operations.md", "完成财务运营全部验收与 verify-finance-operations"), #{ label: "12-finish", capability_mode: "all", resume_from: r12.agent_id, output_schema: work_schema });
    if f12 != () && f12.success { a12.push(f12.output); }
}
let i12 = agent(integration_prompt("12-finance-operations", a12, "运行完整 verify-finance-operations-rest.ts，检查 GL 过账单事务与金额 wire 字符串。"), #{ label: "12-integrate", capability_mode: "all", output_schema: integration_schema });

phase("初始化");
let r16 = agent(worker_prompt(".scratch/ts-backend-rewrite/issues/16-setup-wizard.md", "完整工单 16：公开 setup 状态/初始化向导、管理员与全链示例数据幂等种子、setup e2e；严格限制公开路径"), #{ label: "16-setup", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a16 = [];
if r16 != () && r16.success {
    a16.push(r16.output);
    let f16 = agent(finish_prompt(".scratch/ts-backend-rewrite/issues/16-setup-wizard.md", "完成 setup 与 demo 数据全链幂等验收"), #{ label: "16-finish", capability_mode: "all", resume_from: r16.agent_id, output_schema: work_schema });
    if f16 != () && f16.success { a16.push(f16.output); }
}
let i16 = agent(integration_prompt("16-setup-wizard", a16, "运行 setup e2e、重复初始化拒绝与 demo 数据冒烟；确保公开路由仅限规格允许范围。"), #{ label: "16-integrate", capability_mode: "all", output_schema: integration_schema });

phase("前端切换");
let r17 = agent(worker_prompt(".scratch/ts-backend-rewrite/issues/17-web-hc-cutover.md", "完整工单 17：web 传输层切 hono/client、Resource Client 适配，移除 OpenAPI codegen 消费但不重写 UI；web tsc 与 Playwright"), #{ label: "17-web-hc", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a17 = [];
if r17 != () && r17.success {
    a17.push(r17.output);
    let f17 = agent(finish_prompt(".scratch/ts-backend-rewrite/issues/17-web-hc-cutover.md", "完成 hc 类型链、web tsc 与关键 Playwright；不改 UI 业务行为"), #{ label: "17-finish", capability_mode: "all", resume_from: r17.agent_id, output_schema: work_schema });
    if f17 != () && f17.success { a17.push(f17.output); }
}
let i17 = agent(integration_prompt("17-web-hc-cutover", a17, "集成 web 改造，运行根/server/web typecheck、前端测试和关键 Playwright；确保不再消费旧 OpenAPI 生成客户端。"), #{ label: "17-integrate", capability_mode: "all", output_schema: integration_schema });

phase("全量验收");
let final_review = agent(
    "在 Synie 当前主工作区做 Go→Bun/TS 切流前全量验收和修复。读取全部约束、迁移 spec、issues/01-17 Comments。统计 server-go 实际 HTTP 契约与 Bun 路由，逐个识别缺失/占位；运行 server 全量 bun test/typecheck（含可用 PG）、所有 .scratch/migration/verify-*.ts 对活 Bun API、根与 web typecheck/test、关键 Playwright、Docker 构建冒烟。对失败做根因修复并补测试，不得通过 skip/弱断言/any 绕过。检查金额、权限、公司隔离、事务、Meta、hc 类型链、用户文案与文档同步。可幂等启动本地测试服务/容器，但不得删除数据、不得修改 server-go、不得 push。提交所有修复，留下干净仓库。返回严格验收证据；任何 01-17 硬性项未满足则 green=false 并列 remaining。",
    #{ label: "full-acceptance", capability_mode: "all", output_schema: review_schema }
);

let allow_cleanup = if args == () { false } else if args.allow_cleanup == () { false } else { args.allow_cleanup };
if allow_cleanup != true {
    await_user("user", "工单 01–17 的实现与全量验收阶段已运行。工单 18 将删除 server-go/、归档旧 contracts 并收敛 CI；这是破坏性清场操作。请先查看 workflow 报告与 git 状态，确认后恢复本 workflow 以明确授权执行清场。");
}

phase("清场切流");
let cleanup = agent(
    "用户已通过恢复 workflow 明确授权执行破坏性清场。读取 .scratch/ts-backend-rewrite/issues/18-cleanup-cutover.md、AGENTS、迁移 spec 和当前 git 状态。严格按工单 18 完成：删除/归档规定的 Go 后端与旧契约产物、收敛 compose/Docker/CI/scripts/README/AGENTS/迁移记录和产品文档，但不要删除工单未要求的资料，不要碰未知用户工作，不 push。先确认 01-17 验收状态；若仍有硬阻断，优先修复或停止删除并报告。完成后运行 server/web/根测试与 typecheck、关键 E2E、Docker/CI 等价本地检查；提交清场与修复，仓库干净。",
    #{ label: "18-cleanup", capability_mode: "all", output_schema: review_schema }
);
let cleanup_verify = agent(
    "独立复核当前 Synie 主工作区的工单 18 清场结果。读取工单、git diff/log，确认无 server-go 运行依赖、无旧 OpenAPI 客户端消费、compose/CI/docs 一致；运行可用的 server/web tests、typecheck、关键 E2E 和构建。发现问题直接修复补测试并提交，不 push，不 reset/clean。返回 green、commit、summary、证据和 remaining。",
    #{ label: "18-verify", capability_mode: "all", output_schema: review_schema }
);

complete(#{
    summary: "Go→Bun/TS 全量迁移 workflow 已执行到清场复核",
    baseline_ok: baseline != () && baseline.success,
    acceptance: if final_review != () && final_review.success { final_review.output } else { () },
    cleanup: if cleanup != () && cleanup.success { cleanup.output } else { () },
    cleanup_verification: if cleanup_verify != () && cleanup_verify.success { cleanup_verify.output } else { () },
});
