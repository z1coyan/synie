let meta = #{
    name: "arch-deepening",
    description: "架构深化第二轮：按 .scratch/arch-deepening 工单 01–07 并行落地，08 人工闸；保持 typecheck+全套测试绿",
    phases: [
        #{ title: "基线", detail: "确认 A/B/C 已落地、测试基线、工单仍有效" },
        #{ title: "波次1", detail: "互不重叠：03 printing + 07 引擎瘦身" },
        #{ title: "波次2", detail: "01 过账骨架收尾 + 02 表所有权" },
        #{ title: "波次3", detail: "06 纯核提纯（在 04 拆工厂之前）" },
        #{ title: "波次4", detail: "04 拆巨型工厂 + 05 platform 业务知识回吐" },
        #{ title: "集成验收", detail: "cherry-pick 合入、全绿、更新工单 Comments" },
        #{ title: "人工闸 08", detail: "权限双检约定需用户决策" },
    ],
    when_to_use: "Go→TS 迁移后第二轮架构深化（A/B/C 已落地，执行 01–07）",
};

let audit_schema = #{
    "type": "object",
    "required": ["green", "issues", "summary", "verify_commands"],
    "properties": #{
        "green": #{ "type": "boolean" },
        "issues": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["id", "ready", "notes"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "ready": #{ "type": "boolean" },
                    "notes": #{ "type": "string" },
                },
            },
        },
        "summary": #{ "type": "string" },
        "verify_commands": #{ "type": "array", "items": #{ "type": "string" } },
        "test_count": #{ "type": "string" },
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
        "worktree_branch": #{ "type": "string" },
    },
};

let integration_schema = #{
    "type": "object",
    "required": ["green", "commits", "summary", "tests", "remaining", "issues_updated"],
    "properties": #{
        "green": #{ "type": "boolean" },
        "commits": #{ "type": "array", "items": #{ "type": "string" } },
        "summary": #{ "type": "string" },
        "tests": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
        "issues_updated": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

fn artifacts(results) {
    let found = [];
    for r in results {
        if r != () && r.success && r.output != () { found.push(r.output); }
    }
    found
}

fn common_constraints() {
    let s = "";
    s += "工作区根：/home/zyan/code/synie。第一语言中文。";
    s += "必读：AGENTS.md、server/AGENTS.md、server/README.md、.scratch/arch-deepening/spec.md 与对应 issues/*.md。";
    s += "既定形状（勿回退）：过账=withTx 入口+骨架/seam 编排+引擎只收 TrxHandle；";
    s += "跨域=type-only import + 组合根 Pick<> 注入；模块=工厂闭包（禁 class）；";
    s += "金额=@synie/shared decimal；筛选只走 filterbuild；错误=ApiError。";
    s += "红线：platform 不 import modules/engines；engines 不 import modules；事实表只经引擎写；过账单事务。";
    s += "第一轮 A/B/C 已落地（6a729bb/a8c2710/4917a83/e7c7eb3），禁止重做或回退。";
    s += "验证：cd server && bun run typecheck；";
    s += "SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable bun test（或用 .env DATABASE_URL 改库名为 synie_test）。";
    s += "基线全绿（约 226 测）；每完成一项 typecheck+相关测试绿，单独 conventional commit（中文描述，参照 git log）。";
    s += "禁止 push / reset --hard / clean -fd；禁止改 server-go；业务规则变则同步 docs/产品文档 与 CONTEXT.md。";
    s += "附录 A 死代码可随最近工单顺带删（删前确认无引用）。";
    s
}

let mode = if args == () { "run" } else if args.mode == () { "run" } else { args.mode };

if mode == "smoke" {
    phase("基线");
    let s = agent(
        "用一句中文说明本 workflow：执行 arch-deepening 工单 01–07，08 人工闸。",
        #{ label: "smoke", capability_mode: "read-only" }
    );
    complete(#{ summary: "arch-deepening smoke ok", ok: s != () && s.success });
}

// ─── 基线 ─────────────────────────────────────────────
phase("基线");
let audit_prompt = common_constraints();
audit_prompt += "本阶段只读审计。核对：A/B/C 提交存在；posting.ts 与 createAndAuditJournal seam 在；";
audit_prompt += "工单 01–07 的问题描述与代码现状是否仍匹配（给 ready true/false + notes）；";
audit_prompt += "跑 typecheck 与全量 bun test，记录是否 green 与大致通过数。";
audit_prompt += "勿改代码。返回 schema。";
let audit = agent(audit_prompt, #{
    label: "baseline-audit",
    capability_mode: "execute",
    output_schema: audit_schema,
});
if audit == () || !audit.success {
    log("基线审计失败或未返回 schema，仍继续波次（执行代理须自行验证基线）");
} else if audit.output.green != true {
    log("基线非绿，进入修复后继续：" + audit.output.summary);
    let _fix_base = agent(
        common_constraints() + "主工作区：先把 typecheck 与全量 bun test 修到绿，再报告。只修阻塞测试/环境问题，不做架构重构。返回 work schema。",
        #{ label: "baseline-fix", capability_mode: "all", output_schema: work_schema }
    );
}

// ─── 波次 1：03 + 07（路径重叠少）───────────────────
phase("波次1");
let wave1 = parallel([
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 03-printing-decouple（.scratch/arch-deepening/issues/03-printing-decouple.md）。"
            + "目标：SalesOrderDocBuilder 迁 modules/trading/order/ 并 registerDocBuilder 装配；converter 归组合根；"
            + "删 sales-order-meta.ts 与 catalog-stubs.ts；platform/printing 零业务表查询、零业务枚举标签。"
            + "打印/导出 integration 测试绿。完成后单独 commit。返回 work schema（含 worktree_branch）。",
        label: "issue-03",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 07-engine-interface-slimming（.scratch/arch-deepening/issues/07-engine-interface-slimming.md）。"
            + "目标：validateEntries 补调用方或从 interface 撤下；GlEntry 金额收窄 Decimal|string；"
            + "StockLine 符号进 direction 参数；toDateOnly 收敛 ~/db；引擎注入统一 module index 工厂。"
            + "小步可拆多个 commit。typecheck+全测绿。返回 work schema。",
        label: "issue-07",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
]);

// ─── 波次 2：01 + 02 ─────────────────────────────────
phase("波次2");
let wave2 = parallel([
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 01-posting-skeleton-rollout（.scratch/arch-deepening/issues/01-posting-skeleton-rollout.md）。"
            + "评估并迁入：invoice-service 审核/作废/红冲、expense-service、bill-service（含 replayBill 边界）、"
            + "stock-doc/count/transfer、manufacturing/output-service。"
            + "形状吻合则迁骨架（collect 钩子承载差异）；不合则在 posting.ts 头注释或 issue Comments 记录原因。"
            + "骨架需演化则先改骨架再迁。每单据可单独 commit。返回 work schema。",
        label: "issue-01",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 02-table-ownership-seams（.scratch/arch-deepening/issues/02-table-ownership-seams.md）。"
            + "目标：hr_employees 写路径单点（party 或 employee seam，hr 经 Pick 调 autoCreate）；"
            + "reconciliation 暴露只读查询，finance/accounting 读穿透回 interface；"
            + "banking 共享下沉 banking-shared.ts，删 await import(。审计 sensitiveFields 单点。"
            + "验收 grep 业务表名只剩所有权模块。commit 后返回 work schema。",
        label: "issue-02",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
]);

// ─── 波次 3：06 纯核（先于 04 拆 hr）─────────────────
phase("波次3");
let wave3 = parallel([
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 06-pure-core-extraction（.scratch/arch-deepening/issues/06-pure-core-extraction.md）。"
            + "提纯 replaySegments(txs) 与 applyPayment(payroll,loans)→effects 纯函数 + 薄 IO adapter；"
            + "免 PG 单测覆盖重叠拒绝/金额守恒/调拨换户/联动回滚；行为零变化；module interface 不变。"
            + "参照 hr/rules.ts、bank-parser 惯例。返回 work schema。",
        label: "issue-06",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
]);

// ─── 波次 4：04 + 05 ─────────────────────────────────
phase("波次4");
let wave4 = parallel([
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 04-split-giant-factories（.scratch/arch-deepening/issues/04-split-giant-factories.md）。"
            + "order：拆 outsourced-config（或并入 outsourced/），剔除 4 个透传，fulfillment 直依赖 projection；"
            + "hr：拆 attendance-service + payroll-service，createHrServices 返回 {attendance,payroll}，清 void hack。"
            + "行为零变化；routes 不动以保 web hc 类型。返回 work schema。",
        label: "issue-04",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
    #{
        prompt: common_constraints()
            + "在隔离 worktree 执行工单 05-platform-business-knowledge（.scratch/arch-deepening/issues/05-platform-business-knowledge.md）。"
            + "todo：TodoSource registry 或诚实归 finance；排序静默丢弃改 400 或修 CTE；"
            + "settings：createSingleRowSetting 引擎，声明迁业务域；sampledata 移 modules/setup；numbering 走 catalog。"
            + "grep platform 下业务表名只剩 sys_* 与必要类型引用。返回 work schema。",
        label: "issue-05",
        capability_mode: "all",
        isolation_worktree: true,
        output_schema: work_schema,
    },
]);

let all_arts = [];
for a in artifacts(wave1) { all_arts.push(a); }
for a in artifacts(wave2) { all_arts.push(a); }
for a in artifacts(wave3) { all_arts.push(a); }
for a in artifacts(wave4) { all_arts.push(a); }
log("收集到 " + all_arts.len().to_string() + " 个波次产物");

// ─── 集成验收 ───────────────────────────────────────
phase("集成验收");
let integ_prompt = common_constraints();
integ_prompt += "你在主工作区集成 arch-deepening 各 worktree 产物。候选（须 git cat-file / log 验证）：";
integ_prompt += json_encode(all_arts) + "。";
integ_prompt += "先 git status；按依赖顺序 cherry-pick 有效提交去重；冲突按既定形状语义解决。";
integ_prompt += "合入后：typecheck + 全量 bun test 必须绿。";
integ_prompt += "更新各已完成工单 issues/*.md：Status 改为 resolved（若约定词不同则用 ready-for-human 仅当需人审），";
integ_prompt += "并在 ## Comments 追加完成摘要与 commit sha。";
integ_prompt += "08 保持 ready-for-human 不动。返回 integration schema。";
let integ = agent(integ_prompt, #{
    label: "integrate",
    capability_mode: "all",
    output_schema: integration_schema,
});

if integ == () || !integ.success || integ.output.green != true {
    log("集成未绿或失败，进入修复");
    let _repair = agent(
        common_constraints()
            + "主工作区：修 typecheck/测试/装配至全绿；补未合入的合理提交；更新工单 Comments。"
            + "不 push。返回 integration schema。",
        #{ label: "integrate-repair", capability_mode: "all", output_schema: integration_schema }
    );
}

let accept_prompt = common_constraints();
accept_prompt += "独立验收代理：对照 .scratch/arch-deepening/issues/01–07 验收标准逐项检查。";
accept_prompt += "跑 typecheck + 全量 bun test；对 02/03/05 跑工单内 grep 验收命令。";
accept_prompt += "发现问题直接修并补测提交。不 push。返回 integration schema（issues_updated 列已验项）。";
let accept = agent(accept_prompt, #{
    label: "accept",
    capability_mode: "all",
    output_schema: integration_schema,
});

// ─── 08 人工闸 ──────────────────────────────────────
phase("人工闸 08");
await_user(
    "user",
    "工单 01–07 执行/集成已完成（见 /workflows 与 git log）。工单 08 权限双检需你决策：\n"
        + "方案一 service 唯一检；方案二 routes 声明式鉴码（先于 zValidator）。\n"
        + "banking-recon 双权限码归属一并定。resume 并说明选定方案后可另开任务收敛存量。"
);

let report = #{
    summary: "arch-deepening 01–07 workflow 完成，08 待人工决策",
    baseline: if audit != () && audit.success { audit.output } else { () },
    wave_artifacts: all_arts,
    integration: if integ != () && integ.success { integ.output } else { () },
    acceptance: if accept != () && accept.success { accept.output } else { () },
};
complete(report);
