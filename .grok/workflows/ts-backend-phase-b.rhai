let meta = #{
    name: "ts-backend-phase-b",
    description: "完成 Go→Bun/TS 重写阶段 B：并行工单 04/05/06/07/11/13/14/15 并集成验收",
    phases: [
        #{ title: "业务域并行", detail: "库存单据、手工凭证、销售链、采购链、制造、HR、行情、打印" },
        #{ title: "集成", detail: "主工作区 cherry-pick 与装配" },
        #{ title: "验收修复", detail: "test、typecheck、verify 与独立复审" },
    ],
    when_to_use: "阶段 A（01-03）完成后继续业务域并行迁移时",
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
        if r != () && r.success && r.output != () { found.push(r.output); }
    }
    found
}

fn worker(issue, focus) {
    let p = "在 Synie 仓库实现 Go→Bun/TS 迁移业务域。必读：根 AGENTS.md、server/AGENTS.md、server/README.md、";
    p += ".scratch/ts-backend-rewrite/spec.md、" + issue + "，对应 docs/产品文档 与 server-go 行为（只读）。";
    p += "范围：" + focus + "。硬约束：仅 Bun；工厂闭包；禁 class（ApiError 除外）；严格 TS；金额 @synie/shared decimal；";
    p += "DbHandle/withTx 过账单事务；filterbuild；ApiError；Hono 链式+zValidator；Meta 注册；中文文案；wire 与 Go/OpenAPI 一致。";
    p += "引擎必须复用 server/src/engines/{gl,inventory}，禁止单据直写分录表。隔离 worktree 实现；尽量不改共享 app/index（集成代理合）。";
    p += "真实业务实现；禁空路由/固定成功/skip/any。运行专属测试与 typecheck；PG 用 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable。";
    p += "增量 git commit（不 push）。返回 complete/commits/summary/tests/remaining。";
    p
}

fn finish(issue) {
    "继续 worktree 直至 " + issue + " 验收尽可能绿。重读验收项、补 remaining、运行测试/typecheck、提交。不得占位/改 server-go。返回全部 commits 与 schema。"
}

fn integrate(arts) {
    let p = "主工作区集成阶段 B 八域产物。读约束/spec 与 issues 04,05,06,07,11,13,14,15。候选（须 git 验证）：";
    p += json_encode(arts) + "。先 git status；禁止 reset/clean/push。按依赖 cherry-pick 去重，解决冲突。";
    p += "统一 app/index Meta/路由/依赖/helpers；写工单 Comments。运行 typecheck 与全量 bun test（含 PG）。";
    p += "能起服务则跑对应 verify-inventory/accounting/quotation/order/fulfillment/manufacturing/hr/market/printing。";
    p += "不改 server-go。返回 green/commits/summary/tests/remaining；仓库干净。";
    p
}

let mode = if args == () { "full" } else if args.mode == () { "full" } else { args.mode };
if mode == "smoke" {
    phase("业务域并行");
    let s = agent("用一句中文概括本 workflow。", #{ label: "smoke", capability_mode: "read-only" });
    complete(#{ summary: "phase-b smoke ok", ok: s != () && s.success });
}

phase("业务域并行");
let jobs = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/04-inventory-documents.md", "完整工单04：库存主数据与出入库/调拨/盘点/余额流水，使用库存引擎"), label: "04-inventory", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/05-gl-journals.md", "完整工单05：手工会计凭证与往来/分录报表，使用 GL 引擎"), label: "05-journals", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/06-sales-chain.md", "完整工单06：销售报价→订单→发货装箱全链"), label: "06-sales", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/07-purchase-chain.md", "完整工单07：采购报价→订单→入库全链"), label: "07-purchase", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/11-manufacturing.md", "完整工单11：BOM/工艺/履约需求/工单/生产入库"), label: "11-mfg", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/13-hr.md", "完整工单13：考勤导入/日考勤/工资/支付/借款"), label: "13-hr", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/14-market-jobs.md", "完整工单14：行情品种/价点/取价/调度 jobs"), label: "14-market", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/15-printing-engine.md", "完整工单15：打印模板/zip+XML 渲染/PDF/字段目录；禁 exceljs"), label: "15-print", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r = parallel(jobs);
let follow = [];
for item in r {
    if item != () && item.success {
        follow.push(#{ prompt: finish("所属工单"), label: "B-finish", capability_mode: "all", resume_from: item.agent_id, output_schema: work_schema });
    }
}
let f = if follow.len() > 0 { parallel(follow) } else { [] };
let arts = artifacts(r);
for a in artifacts(f) { arts.push(a); }

phase("集成");
let integ = agent(integrate(arts), #{ label: "B-integrate", capability_mode: "all", output_schema: integration_schema });

phase("验收修复");
let review = agent(
    "独立验收修复阶段 B。读 issues 04,05,06,07,11,13,14,15 与代码 diff。运行 cd server && SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test 与 typecheck。对照 server-go/OpenAPI 查缺失端点、占位、事务、金额、权限、Meta、hc 链。能起服务则跑相关 verify。发现问题直接修并提交，不 push/reset。返回 green/commit/summary/evidence/remaining。",
    #{ label: "B-review", capability_mode: "all", output_schema: review_schema }
);

complete(#{
    summary: "阶段 B workflow 完成",
    integration: if integ != () && integ.success { integ.output } else { () },
    review: if review != () && review.success { review.output } else { () },
});
