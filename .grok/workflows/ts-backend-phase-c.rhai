let meta = #{
    name: "ts-backend-phase-c",
    description: "完成 Go→Bun/TS 重写阶段 C：对账/发票待办/委外/财务运营/setup/web 切流",
    phases: [
        #{ title: "对账 08", detail: "销售/采购对账" },
        #{ title: "发票与委外", detail: "并行 09 与 10" },
        #{ title: "财务运营 12", detail: "银行/票据/报销" },
        #{ title: "Setup 与 Web", detail: "并行 16 与 17" },
        #{ title: "收口验收", detail: "全量测试与 verify" },
    ],
    when_to_use: "阶段 B 完成后继续 08–12/16/17 时",
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
    let p = "在 Synie 实现 Go→Bun/TS 剩余工单。必读 AGENTS、server/README、spec、" + issue + " 与 server-go（只读）。";
    p += "范围：" + focus + "。硬约束：Bun-only、工厂闭包、decimal、DbHandle/withTx、filterbuild、ApiError、Hono 链式+zValidator、Meta、wire 一致。";
    p += "复用已有 engines 与 trading/inventory/accounting 模块；隔离 worktree；尽量不改共享装配（集成合）。";
    p += "真实实现；禁占位/skip/any。测试+typecheck；PG=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable。";
    p += "commit 不 push。返回 complete/commits/summary/tests/remaining。";
    p
}

fn finish(issue) {
    "继续 worktree 完成 " + issue + " 验收。补 remaining、跑测试/typecheck/verify，提交。禁改 server-go。"
}

fn integrate(issues, arts, extra) {
    let p = "主工作区集成 " + issues + "。候选产物：" + json_encode(arts) + "。禁止 reset/clean/push。";
    p += "cherry-pick 去重并解决冲突；装配 app/index/Meta/helpers；写 Comments。";
    p += "typecheck + 全量 bun test（含 PG）。" + extra + " 不改 server-go。返回 green/commits/summary/tests/remaining。";
    p
}

let mode = if args == () { "full" } else if args.mode == () { "full" } else { args.mode };
if mode == "smoke" {
    phase("对账 08");
    let s = agent("一句中文概括本 workflow。", #{ label: "smoke", capability_mode: "read-only" });
    complete(#{ summary: "phase-c smoke ok", ok: s != () && s.success });
}

phase("对账 08");
let r08 = agent(worker(".scratch/ts-backend-rewrite/issues/08-reconciliations.md", "完整销售/采购对账：来源行/差额/审核作废投影/权限公司隔离/契约"), #{ label: "08-rec", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a08 = [];
if r08 != () && r08.success {
    a08.push(r08.output);
    let f08 = agent(finish("08"), #{ label: "08-finish", capability_mode: "all", resume_from: r08.agent_id, output_schema: work_schema });
    if f08 != () && f08.success { a08.push(f08.output); }
}
let i08 = agent(integrate("08", a08, "跑 verify-supply-reconciliation-rest.ts。"), #{ label: "08-int", capability_mode: "all", output_schema: integration_schema });

phase("发票与委外");
let jobs = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/09-invoices-todo.md", "完整发票（销项/进项/费用）+ 待办生产与用户状态 API"), label: "09-inv", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/10-outsourced.md", "完整委外订单配置/发料/入库/材料副产品/引擎与契约；替换占位"), label: "10-out", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r = parallel(jobs);
let follow = [];
for item in r {
    if item != () && item.success {
        follow.push(#{ prompt: finish("所属工单"), label: "D-finish", capability_mode: "all", resume_from: item.agent_id, output_schema: work_schema });
    }
}
let f = if follow.len() > 0 { parallel(follow) } else { [] };
let arts = artifacts(r);
for a in artifacts(f) { arts.push(a); }
let id = agent(integrate("09,10", arts, "跑 finance 发票段与 fulfillment outsourced verify；打通 todos 使 verify-system-ops 绿。"), #{ label: "D-int", capability_mode: "all", output_schema: integration_schema });

phase("财务运营 12");
let r12 = agent(worker(".scratch/ts-backend-rewrite/issues/12-finance-operations.md", "完整银行/票据/报销，衔接 GL/发票/待办"), #{ label: "12-fin", capability_mode: "all", isolation_worktree: true, output_schema: work_schema });
let a12 = [];
if r12 != () && r12.success {
    a12.push(r12.output);
    let f12 = agent(finish("12"), #{ label: "12-finish", capability_mode: "all", resume_from: r12.agent_id, output_schema: work_schema });
    if f12 != () && f12.success { a12.push(f12.output); }
}
let i12 = agent(integrate("12", a12, "跑完整 verify-finance-operations-rest.ts。"), #{ label: "12-int", capability_mode: "all", output_schema: integration_schema });

phase("Setup 与 Web");
let jobs2 = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/16-setup-wizard.md", "公开 setup 状态/初始化向导、示例数据幂等种子；限制公开路径"), label: "16-setup", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/17-web-hc-cutover.md", "web 切 hono/client 与 Resource Client；不改 UI 业务；web tsc/Playwright"), label: "17-web", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r2 = parallel(jobs2);
let follow2 = [];
for item in r2 {
    if item != () && item.success {
        follow2.push(#{ prompt: finish("所属工单"), label: "F-finish", capability_mode: "all", resume_from: item.agent_id, output_schema: work_schema });
    }
}
let f2 = if follow2.len() > 0 { parallel(follow2) } else { [] };
let arts2 = artifacts(r2);
for a in artifacts(f2) { arts2.push(a); }
let i2 = agent(integrate("16,17", arts2, "跑 setup 冒烟与 web typecheck/关键 e2e。"), #{ label: "F-int", capability_mode: "all", output_schema: integration_schema });

phase("收口验收");
let final = agent(
    "独立全量验收修复 08–12/16/17。读工单 Comments 与代码。运行 server typecheck 与 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test；尽量跑全部 .scratch/migration/verify-*.ts 对 Bun。查缺失端点/占位/权限/金额/事务/Meta/hc。修复并提交，不 push/reset。不执行工单18 删除 server-go。返回 green/commit/summary/evidence/remaining。",
    #{ label: "C-accept", capability_mode: "all", output_schema: review_schema }
);

complete(#{
    summary: "阶段 C workflow 完成（不含破坏性清场 18）",
    acceptance: if final != () && final.success { final.output } else { () },
});
