let meta = #{
    name: "resource-catalog-migrate",
    description: "Resource Catalog 工单 07–11：单位/供应商/公司表单、命令、Presentation、剩余迁移与收缩",
    phases: [
        #{ title: "基线", detail: "确认 01–06 已合入、测试绿" },
        #{ title: "07 简单主数据", detail: "单位/供应商/公司 Basic Form" },
        #{ title: "08 命令", detail: "CommandAdapter setDefault/recalc/reconcile" },
        #{ title: "09 呈现与聚合", detail: "客户附件、发票 OCR、发货 AggregateDraft" },
        #{ title: "10 剩余迁移", detail: "按领域批次分类并迁出 legacy" },
        #{ title: "11 收缩", detail: "删除 v1/legacy registries" },
        #{ title: "验收", detail: "typecheck + 全量测试 + 工单 resolved" },
    ],
    when_to_use: "resource-catalog 01–06 已落地后执行 migrate–contract",
};

let work_schema = #{
    "type": "object",
    "required": ["complete", "summary", "commits", "remaining"],
    "properties": #{
        "complete": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "commits": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
        "tests": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

fn constraints() {
    let s = "";
    s += "工作区 /home/zyan/code/synie。中文第一语言。";
    s += "必读：.scratch/resource-catalog/spec.md、对应 issues/*.md、docs/adr/2026-07-30-resource-catalog.md、AGENTS.md。";
    s += "已完成：01 统一注册+基线、02 ResourceDocument v2、03 sealed 双投影、04 ResourceReadSpec、05 ResourceBinding、06 币种 Basic Form。";
    s += "已有代码：server/src/platform/meta/*、packages/shared/src/resource-document*、web/app/lib/resources/catalog/*。";
    s += "迁移策略 expand–migrate–contract；禁止 Meta 驱动 SQL 写入；Presentation Extension 与业务共置。";
    s += "验证：packages/shared bun test；server bun run typecheck && bun test src/platform/meta；web bun run typecheck && bun test app/lib/resources/catalog；全量按需。";
    s += "每完成一工单 conventional commit（中文）、更新 issue Status: resolved。禁止 push / reset --hard。";
    s
}

let mode = if args == () { "run" } else if args.mode == () { "run" } else { args.mode };

if mode == "smoke" {
    phase("基线");
    let s = agent(
        "用一句中文说明本 workflow 执行 resource-catalog 工单 07–11。",
        #{ label: "smoke", capability_mode: "read-only" }
    );
    complete(#{ summary: "resource-catalog-migrate smoke ok", ok: s != () && s.success });
}

phase("基线");
let audit = agent(
    constraints() + " 只读检查：确认 issues 01–06 为 resolved，git log 含 catalog 相关提交；列出 07–11 未完成清单。输出 summary。",
    #{ label: "audit-baseline", capability_mode: "read-only", output_schema: work_schema }
);
if audit == () || !audit.success {
    complete(#{ summary: "基线检查失败", complete: false });
}

phase("07 简单主数据");
let t07 = agent(
    constraints() + " 实施 .scratch/resource-catalog/issues/07-migrate-simple-master-data-forms.md。"
        + " 复用 basicFormDrawerProps / useResourceDocument / resourceBindingFor。"
        + " 迁移 basUnits、purSuppliers、basCompanies；客户明确为 extension。"
        + " 完成后 typecheck+相关测试绿，commit，标记 issue resolved。",
    #{ label: "issue-07", capability_mode: "all", output_schema: work_schema }
);

phase("08 命令");
let t08 = agent(
    constraints() + " 实施 .scratch/resource-catalog/issues/08-migrate-command-adapters.md。"
        + " setDefault/recalc/reconcile 语义 command；非法 target fail-closed；未授权 API 仍 403。"
        + " 完成后 commit 并 resolve issue 08。",
    #{ label: "issue-08", capability_mode: "all", output_schema: work_schema }
);

phase("09 呈现与聚合");
let t09 = agent(
    constraints() + " 实施 .scratch/resource-catalog/issues/09-prove-presentation-and-aggregate-adapters.md。"
        + " 客户附件、发票 OCR 为 Presentation Extension；销售发货 AggregateDraftAdapter + 完整草稿读取。"
        + " 完成后 commit 并 resolve issue 09。",
    #{ label: "issue-09", capability_mode: "all", output_schema: work_schema }
);

phase("10 剩余迁移");
let t10 = agent(
    constraints() + " 实施 .scratch/resource-catalog/issues/10-migrate-remaining-resource-presentations.md。"
        + " 依赖 07–09 已完成；按领域批次迁移；更新基线报告 gaps 归零或显式分类。"
        + " 完成后 commit 并 resolve issue 10。",
    #{ label: "issue-10", capability_mode: "all", output_schema: work_schema }
);

phase("11 收缩");
let t11 = agent(
    constraints() + " 实施 .scratch/resource-catalog/issues/11-contract-legacy-resource-meta.md。"
        + " 仅在 10 证明零缺口后删除 v1 grid sibling、legacy normalizer、宽 ResourceClient、drawer registry、remote defaults。"
        + " 全量 typecheck/test/build 绿；更新架构文档为已实施。commit 并 resolve 11。",
    #{ label: "issue-11", capability_mode: "all", output_schema: work_schema }
);

phase("验收");
let verify = agent(
    constraints() + " 汇总 07–11 完成度；跑 shared+server meta+web catalog 测试与 typecheck；"
        + " 列出仍 open 的 issue 与剩余工作。",
    #{ label: "verify", capability_mode: "execute", output_schema: work_schema }
);

let done = 0;
let parts = [t07, t08, t09, t10, t11];
for p in parts {
    if p != () && p.success && p.output != () && p.output.complete == true {
        done += 1;
    }
}

complete(#{
    summary: "resource-catalog-migrate finished " + done.to_string() + "/5 tickets complete path",
    issue07: if t07 != () && t07.success { t07.output } else { () },
    issue08: if t08 != () && t08.success { t08.output } else { () },
    issue09: if t09 != () && t09.success { t09.output } else { () },
    issue10: if t10 != () && t10.success { t10.output } else { () },
    issue11: if t11 != () && t11.success { t11.output } else { () },
    verify: if verify != () && verify.success { verify.output } else { () },
});
