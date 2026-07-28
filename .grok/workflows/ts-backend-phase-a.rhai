let meta = #{
    name: "ts-backend-phase-a",
    description: "完成 Go→Bun/TS 重写阶段 A：工单 01 平台补全、02 base/IAM/party、03 GL/库存引擎",
    phases: [
        #{ title: "平台 01", detail: "settings/numbering/audit/files 并行实现与集成" },
        #{ title: "基础域 02", detail: "base/IAM/party/供应链设置并行实现与集成" },
        #{ title: "引擎 03", detail: "GL 与库存引擎并行实现与集成" },
        #{ title: "阶段验收", detail: "test、typecheck、verify 与独立复审" },
    ],
    when_to_use: "从骨架继续做迁移关键路径 01→02→03 时",
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
    let p = "在 Synie 仓库实现 Go→Bun/TS 迁移分片。必读：根 AGENTS.md、server/AGENTS.md、server/README.md、";
    p += ".scratch/ts-backend-rewrite/spec.md、" + issue + "，以及 server-go 对应实现（只读）。";
    p += "范围：" + focus + "。硬约束：仅 Bun；工厂闭包；禁 class（ApiError 除外）；严格 TS；金额走 @synie/shared decimal；";
    p += "DbHandle/withTx；filterbuild；ApiError；Hono 链式+zValidator；Meta 注册；中文文案；wire 与 Go/OpenAPI 一致。";
    p += "在隔离 worktree 实现；尽量不改 app.ts/index.ts/共享装配与工单 Comments（集成代理负责）。";
    p += "实现真实业务；禁止空路由/固定成功/skip 测试/any 占位。运行专属测试与 cd server && bun run typecheck。";
    p += "有 PG 则 SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable。";
    p += "每个可用增量 git commit（不 push）。完成后按 schema 返回 complete/commits/summary/tests/remaining。";
    p
}

fn finish(issue) {
    let p = "继续你的 worktree 实现直至验收。重读 " + issue + " 验收项、git status/diff/log，补齐 remaining，";
    p += "运行测试与 typecheck，修复问题后提交。不得占位或改 server-go。返回全部任务 commits 与 schema。";
    p
}

fn integrate(issue, arts, extra) {
    let p = "你在主工作区集成迁移分片。读取约束、spec、" + issue + "。候选产物（须 git cat-file 验证）：";
    p += json_encode(arts) + "。先 git status；禁止 reset/clean/push。按依赖 cherry-pick 有效提交并去重；";
    p += "冲突需语义解决。统一装配 app/index、Meta、依赖、测试、工单 Comments。";
    p += "运行 cd server && bun test 与 typecheck；有库则 PG 集成；" + extra;
    p += "不改 server-go。返回 green/commits/summary/tests/remaining；仓库须干净。";
    p
}

fn review(issue, scope) {
    let p = "独立验收修复。读约束/spec/" + issue + "。范围：" + scope + "。实际读代码并运行";
    p += " cd server && SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test";
    p += " 与 bun run typecheck。对照 server-go/OpenAPI 查 wire、权限、金额、事务、Meta、hc 链。";
    p += "发现问题直接修并提交，不 push/reset。返回 green/commit/summary/evidence/remaining。";
    p
}

let mode = if args == () { "full" } else if args.mode == () { "full" } else { args.mode };
if mode == "smoke" {
    phase("平台 01");
    let s = agent("用一句中文概括本 workflow 目标。", #{ label: "smoke", capability_mode: "read-only" });
    complete(#{ summary: "phase-a smoke ok", ok: s != () && s.success });
}

phase("平台 01");
let jobs01 = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "settings 四类单行设置、write-only 密钥、GET/PATCH 路由、Meta、测试"), label: "01-settings", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "numbering 规则 CRUD/取号/计数器/级联/并发、Meta、路由、测试"), label: "01-numbering", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "audit 字段级不可变审计、敏感字段脱敏、服务钩子与测试"), label: "01-audit", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/01-platform-completion.md", "files 文件/存储/附件、50MB/SHA256、local+S3、默认存储锁、宿主白名单、权限公司隔离、路由测试"), label: "01-files", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r01 = parallel(jobs01);
let follow01 = [];
for r in r01 {
    if r != () && r.success {
        follow01.push(#{ prompt: finish(".scratch/ts-backend-rewrite/issues/01-platform-completion.md"), label: "01-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema });
    }
}
let f01 = if follow01.len() > 0 { parallel(follow01) } else { [] };
let a01 = artifacts(r01);
for a in artifacts(f01) { a01.push(a); }
let i01 = agent(integrate("01-platform-completion", a01, "泛化 verify-settings/numbering 的 SYNIE_API_URL；能起服务则跑 verify。"), #{ label: "01-integrate", capability_mode: "all", output_schema: integration_schema });
if i01 == () || !i01.success || !i01.output.green {
    let _r = agent(review("01", "settings/numbering/audit/files 全验收"), #{ label: "01-repair", capability_mode: "all", output_schema: review_schema });
}

phase("基础域 02");
let jobs02 = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "base 公司/三仓同事务、货币、单位、科目树约束、Meta/路由/测试"), label: "02-base", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "iam 用户角色授权/公司授权 fail-closed/权限矩阵、Meta/路由/测试"), label: "02-iam", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "party 客户供应商编号规则、员工主数据唯一性、Meta/路由/测试"), label: "02-party", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md", "公司默认过账科目四槽、销售/采购分侧 upsert、科目校验、路由测试"), label: "02-supply", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r02 = parallel(jobs02);
let follow02 = [];
for r in r02 {
    if r != () && r.success {
        follow02.push(#{ prompt: finish(".scratch/ts-backend-rewrite/issues/02-base-master-data-iam.md"), label: "02-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema });
    }
}
let f02 = if follow02.len() > 0 { parallel(follow02) } else { [] };
let a02 = artifacts(r02);
for a in artifacts(f02) { a02.push(a); }
let i02 = agent(integrate("02-base-master-data-iam", a02, "运行 verify-system-ops 与 verify-party-employee 指向 Bun 若可行。"), #{ label: "02-integrate", capability_mode: "all", output_schema: integration_schema });
if i02 == () || !i02.success || !i02.output.green {
    let _r2 = agent(review("02", "base/IAM/party/供应链设置全验收"), #{ label: "02-repair", capability_mode: "all", output_schema: review_schema });
}

phase("引擎 03");
let jobs03 = [
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/03-engines.md", "GL 引擎 validate/post/cancel/reverse 与 PG 不变量；DbHandle；禁 import modules"), label: "03-gl", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
    #{ prompt: worker(".scratch/ts-backend-rewrite/issues/03-engines.md", "库存引擎 post/cancel、advisory lock、默认单位、叶子仓、负库存、并发 PG 测试；DbHandle"), label: "03-inv", capability_mode: "all", isolation_worktree: true, output_schema: work_schema },
];
let r03 = parallel(jobs03);
let follow03 = [];
for r in r03 {
    if r != () && r.success {
        follow03.push(#{ prompt: finish(".scratch/ts-backend-rewrite/issues/03-engines.md"), label: "03-finish", capability_mode: "all", resume_from: r.agent_id, output_schema: work_schema });
    }
}
let f03 = if follow03.len() > 0 { parallel(follow03) } else { [] };
let a03 = artifacts(r03);
for a in artifacts(f03) { a03.push(a); }
let i03 = agent(integrate("03-engines", a03, "稳定引擎公开签名；禁引擎自起事务。"), #{ label: "03-integrate", capability_mode: "all", output_schema: integration_schema });
if i03 == () || !i03.success || !i03.output.green {
    let _r3 = agent(review("03", "GL/库存引擎不变量与事务边界"), #{ label: "03-repair", capability_mode: "all", output_schema: review_schema });
}

phase("阶段验收");
let final = agent(review("01,02,03", "阶段 A 全验收：平台四模块、base/IAM/party、GL/库存引擎；verify 能跑则跑"), #{ label: "phase-a-accept", capability_mode: "all", output_schema: review_schema });
complete(#{
    summary: "阶段 A（01-03）workflow 完成",
    acceptance: if final != () && final.success { final.output } else { () },
});
