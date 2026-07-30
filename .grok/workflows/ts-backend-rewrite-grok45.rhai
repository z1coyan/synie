let meta = #{
    name: "ts-backend-rewrite-grok45",
    description: "用 grok-4.5 从当前断点续跑 Go→Bun/TS 重写：审计缺口、并行修复、全量验收；工单18需确认",
    phases: [
        #{ title: "基线审计", detail: "对照 18 工单与代码/测试盘点真实缺口" },
        #{ title: "缺口修复", detail: "按缺口并行 worktree 修复与补测" },
        #{ title: "集成", detail: "主工作区合入与装配" },
        #{ title: "全量验收", detail: "test/typecheck/verify 与独立复审" },
        #{ title: "清场 18", detail: "经确认后删除 server-go 与 CI 收敛" },
    ],
    when_to_use: "main 已有迁移进度时，用 grok-4.5 重新编排收口与补齐",
};

let audit_schema = #{
    "type": "object",
    "required": ["issues", "summary", "critical_gaps", "verify_commands"],
    "properties": #{
        "issues": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["id", "status", "complete", "gaps"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "status": #{ "type": "string" },
                    "complete": #{ "type": "boolean" },
                    "gaps": #{ "type": "array", "items": #{ "type": "string" } },
                },
            },
        },
        "summary": #{ "type": "string" },
        "critical_gaps": #{ "type": "array", "items": #{ "type": "string" } },
        "verify_commands": #{ "type": "array", "items": #{ "type": "string" } },
    },
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

let mode = if args == () { "resume" } else if args.mode == () { "resume" } else { args.mode };
let allow_cleanup = if args == () { false } else if args.allow_cleanup == () { false } else { args.allow_cleanup };

if mode == "smoke" {
    phase("基线审计");
    let s = agent(
        "用一句中文说明本 workflow：在已有 01-17 进度上用 grok-4.5 审计缺口、修复、验收，工单18需确认。",
        #{ label: "smoke", capability_mode: "read-only", model: "grok-4.5" }
    );
    complete(#{ summary: "grok45 rewrite smoke ok", ok: s != () && s.success });
}

phase("基线审计");
let audit_prompt = "你在 /home/zyan/code/synie 只读审计 Go→Bun/TS 迁移进度。";
audit_prompt += "必读：AGENTS.md、server/AGENTS.md、server/README.md、.scratch/ts-backend-rewrite/spec.md 与 issues/01-18。";
audit_prompt += "用 git log/status、find、grep、read_file 核对 server/ 实现与 server-go 只读对照。";
audit_prompt += "运行 cd server && bun run typecheck 与 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test（可修环境但不改业务语义以外代码；本阶段优先只读，环境阻断只记录）。";
audit_prompt += "对 01-18 逐项给出 complete true/false 与具体 gaps（文件路径/端点/测试/verify）。";
audit_prompt += "禁止 reset/clean/push；禁止删除 server-go。";
audit_prompt += "返回 schema：issues 数组、summary、critical_gaps、verify_commands。";
let audit = agent(audit_prompt, #{
    label: "audit",
    capability_mode: "execute",
    model: "grok-4.5",
    output_schema: audit_schema,
});
if audit == () || !audit.success {
    log("审计失败，仍进入通用缺口修复");
}

phase("缺口修复");
// 固定扇出：对关键工单簇并行复查修复；代理必须先读现状，已完成则只补缺口不重写。
let fix_jobs = [
    #{
        prompt: "用 grok-4.5 在隔离 worktree 修复/补齐工单 01-03（平台/base-IAM-party/引擎）。先读 issues 与当前 server 代码；已完整则只补测试与 Comments。硬约束：Bun、工厂闭包、decimal、DbHandle、filterbuild、ApiError、Hono 链式+zValidator、Meta、wire 一致。禁止改 server-go。PG=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable。提交不 push。返回 complete/commits/summary/tests/remaining。",
        label: "fix-01-03", capability_mode: "all", isolation_worktree: true, model: "grok-4.5", output_schema: work_schema
    },
    #{
        prompt: "用 grok-4.5 在隔离 worktree 修复/补齐工单 04-05-06-07（库存单据、手工凭证、销采链）。先读 issues 与现有 modules；复用 engines；已完整则只补缺口与 verify 对齐。禁 server-go；提交不 push。返回 schema。",
        label: "fix-04-07", capability_mode: "all", isolation_worktree: true, model: "grok-4.5", output_schema: work_schema
    },
    #{
        prompt: "用 grok-4.5 在隔离 worktree 修复/补齐工单 08-10-11（对账、委外、制造）。先读现状；补完整业务与契约，禁占位。禁 server-go；提交不 push。返回 schema。",
        label: "fix-08-11", capability_mode: "all", isolation_worktree: true, model: "grok-4.5", output_schema: work_schema
    },
    #{
        prompt: "用 grok-4.5 在隔离 worktree 修复/补齐工单 09-12-13-14（发票待办、财务运营、HR、行情 jobs）。先读现状；补缺口与测试。禁 server-go；提交不 push。返回 schema。",
        label: "fix-09-14", capability_mode: "all", isolation_worktree: true, model: "grok-4.5", output_schema: work_schema
    },
    #{
        prompt: "用 grok-4.5 在隔离 worktree 修复/补齐工单 15-16-17（打印、setup、web hc 切流）。先读现状；打印禁 exceljs；web 只换传输层不重写 UI。禁 server-go；提交不 push。返回 schema。",
        label: "fix-15-17", capability_mode: "all", isolation_worktree: true, model: "grok-4.5", output_schema: work_schema
    },
];
let fixes = parallel(fix_jobs);
let finish_jobs = [];
for r in fixes {
    if r != () && r.success {
        finish_jobs.push(#{
            prompt: "继续你的 worktree：重读所属工单验收，补 remaining，跑 typecheck/专属测试，提交。禁占位与改 server-go。返回全部 commits 与 schema。",
            label: "fix-finish",
            capability_mode: "all",
            resume_from: r.agent_id,
            model: "grok-4.5",
            output_schema: work_schema,
        });
    }
}
let finished = if finish_jobs.len() > 0 { parallel(finish_jobs) } else { [] };
let arts = artifacts(fixes);
for a in artifacts(finished) { arts.push(a); }

phase("集成");
let integ_prompt = "你在主工作区集成 grok-4.5 缺口修复产物。读 AGENTS/spec 与 01-17 工单。";
integ_prompt += "候选产物（须 git cat-file 验证）：" + json_encode(arts) + "。";
integ_prompt += "先 git status；禁止 reset/clean/push。按依赖 cherry-pick 有效提交去重，冲突语义解决。";
integ_prompt += "统一 app/index Meta/路由/helpers；更新工单 Comments（Status 保持约定词）。";
integ_prompt += "运行 cd server && bun run typecheck 与 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test。";
integ_prompt += "能起服务则对独立库跑 .scratch/migration/verify-*.ts（SYNIE_API_URL）。";
integ_prompt += "不改 server-go。返回 green/commits/summary/tests/remaining。";
let integ = agent(integ_prompt, #{
    label: "integrate",
    capability_mode: "all",
    model: "grok-4.5",
    output_schema: integration_schema,
});
if integ == () || !integ.success || !integ.output.green {
    let _repair = agent(
        "集成未绿。在主工作区修复类型/测试/装配问题，提交不 push，不改 server-go。跑 server typecheck+全量 bun test。返回 review schema。",
        #{ label: "integrate-repair", capability_mode: "all", model: "grok-4.5", output_schema: review_schema }
    );
}

phase("全量验收");
let accept_prompt = "作为独立验收代理（grok-4.5），在主工作区全量验收 01-17。";
accept_prompt += "读 issues Comments 与代码。运行 server typecheck 与 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test；";
accept_prompt += "web typecheck/test；尽量跑全部 .scratch/migration/verify-*.ts 对 Bun（独立测试库+seed）。";
accept_prompt += "对照 server-go/OpenAPI 查缺失端点、占位、权限、金额、事务、Meta、hc 链。";
accept_prompt += "发现问题直接修并补测试提交；不 push/reset；不执行工单18。";
accept_prompt += "返回 green/commit/summary/evidence/remaining。";
let accept = agent(accept_prompt, #{
    label: "full-accept",
    capability_mode: "all",
    model: "grok-4.5",
    output_schema: review_schema,
});

if allow_cleanup != true {
    await_user("user", "01-17 已用 grok-4.5 审计/修复/验收。工单18将删除 server-go 并收敛 CI/compose（破坏性）。确认后 resume 本 workflow 并确保 args.allow_cleanup=true 或直接授权继续清场。");
}

phase("清场 18");
let clean_prompt = "用户已授权破坏性清场。读 .scratch/ts-backend-rewrite/issues/18-cleanup-cutover.md。";
clean_prompt += "按工单：tag 后删 server-go、归档 openapi、收敛 CI/compose/README/AGENTS/迁移文档；不删 backend/ Elixir 参考。";
clean_prompt += "先确认 01-17 无明显硬阻断。完成后跑 server/web 测试 typecheck 与关键 e2e。提交不 push。返回 review schema。";
let cleanup = agent(clean_prompt, #{
    label: "18-cleanup",
    capability_mode: "all",
    model: "grok-4.5",
    output_schema: review_schema,
});
let clean_verify = agent(
    "独立复核工单18：无 server-go 运行依赖、docs/CI 一致；跑可用测试。修问题并提交，不 push。返回 review schema。",
    #{ label: "18-verify", capability_mode: "all", model: "grok-4.5", output_schema: review_schema }
);

let report = #{
    summary: "grok-4.5 迁移收口 workflow 完成",
    audit: if audit != () && audit.success { audit.output } else { () },
    integration: if integ != () && integ.success { integ.output } else { () },
    acceptance: if accept != () && accept.success { accept.output } else { () },
    cleanup: if cleanup != () && cleanup.success { cleanup.output } else { () },
    cleanup_verify: if clean_verify != () && clean_verify.success { clean_verify.output } else { () },
};
complete(report);
